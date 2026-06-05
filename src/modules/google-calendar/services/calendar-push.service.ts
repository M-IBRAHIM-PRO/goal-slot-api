import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { calendar_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../shared/services/encryption.service';
import { errMessage, GoogleApiService, isInvalidGrant } from './google-api.service';

const PROVIDER = 'google';
const GOAL_SLOT_CALENDAR_NAME = 'GoalSlot';
// Tags each pushed Google event with the local block id so reconcile can map
// events back to blocks and prune orphans.
const BLOCK_ID_PROP = 'goalSlotBlockId';
// RRULE BYDAY codes indexed by ScheduleBlock.dayOfWeek (0 = Sunday).
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WEEKDAY_TO_DOW: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * Pushes the user's weekly ScheduleBlocks into a dedicated "GoalSlot" Google
 * calendar as recurring events. Reconcile-based: every trigger rebuilds the
 * desired state and diffs it against what's in the calendar (insert / patch /
 * prune), which makes it idempotent and robust to the series/updateMany paths
 * in ScheduleService that don't surface individual rows.
 */
@Injectable()
export class CalendarPushService {
  private readonly logger = new Logger(CalendarPushService.name);

  // Per-user reentrancy: schedule edits fire reconcile() fire-and-forget and
  // can overlap. Run one at a time per user; if another edit lands mid-run,
  // remember it and re-run once after, so we never lose the latest state nor
  // race two passes inserting duplicate events.
  private readonly running = new Set<string>();
  private readonly pending = new Set<string>();
  // Cron-level guard so a slow sweep can't overlap the next tick.
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly googleApi: GoogleApiService,
  ) {}

  // Fire-and-forget entry point used by ScheduleService and the controller.
  // Coalesces overlapping calls per user.
  async reconcileUserPush(userId: string): Promise<void> {
    if (this.running.has(userId)) {
      this.pending.add(userId);
      return;
    }
    this.running.add(userId);
    try {
      await this.reconcile(userId);
    } catch (err) {
      this.logger.error(`Push reconcile failed for user ${userId}: ${errMessage(err)}`);
    } finally {
      this.running.delete(userId);
      if (this.pending.delete(userId)) {
        void this.reconcileUserPush(userId).catch((err) =>
          this.logger.error(`Re-run reconcile failed for user ${userId}: ${errMessage(err)}`),
        );
      }
    }
  }

  // Tear down the push side: delete the GoalSlot calendar at Google and clear
  // local pointers. Re-enabling later recreates a clean calendar from scratch.
  async disablePush(userId: string): Promise<void> {
    const connection = await this.prisma.calendarConnection.findFirst({
      where: { userId, provider: PROVIDER },
    });
    if (!connection) return;

    if (connection.goalSlotCalendarId && connection.status === 'active') {
      try {
        const client = this.clientFor(connection);
        await this.googleApi.deleteCalendar(client, connection.goalSlotCalendarId);
      } catch (err) {
        // Best-effort: local cleanup proceeds regardless.
        this.logger.warn(`GoalSlot calendar delete failed (ignored): ${errMessage(err)}`);
      }
    }

    await this.prisma.$transaction([
      this.prisma.calendarConnection.update({
        where: { id: connection.id },
        data: { pushEnabled: false, goalSlotCalendarId: null },
      }),
      this.prisma.scheduleBlock.updateMany({
        where: { userId, googleEventId: { not: null } },
        data: { googleEventId: null },
      }),
    ]);
  }

  // 15-minute backstop: reconcile every push-enabled active connection so a
  // missed/failed trigger eventually heals. Less urgent than inbound sync, so
  // a slower cadence on its own guard.
  @Cron('*/15 * * * *')
  async sweepAll(): Promise<void> {
    if (!this.googleApi.isConfigured) return;
    if (this.sweeping) {
      this.logger.debug('Push sweep already in progress, skipping this tick');
      return;
    }
    this.sweeping = true;
    try {
      const connections = await this.prisma.calendarConnection.findMany({
        where: { status: 'active', pushEnabled: true },
        select: { userId: true },
      });
      for (const { userId } of connections) {
        await this.reconcileUserPush(userId);
      }
    } finally {
      this.sweeping = false;
    }
  }

  // --- core ---

  private async reconcile(userId: string): Promise<void> {
    const connection = await this.prisma.calendarConnection.findFirst({
      where: { userId, provider: PROVIDER },
    });
    if (!connection || connection.status !== 'active' || !connection.pushEnabled) return;

    const client = this.clientFor(connection);

    // Lazily create the dedicated calendar on first push.
    let calendarId = connection.goalSlotCalendarId;
    if (!calendarId) {
      calendarId = await this.googleApi.createCalendar(client, GOAL_SLOT_CALENDAR_NAME);
      await this.prisma.calendarConnection.update({
        where: { id: connection.id },
        data: { goalSlotCalendarId: calendarId },
      });
    }

    try {
      const [existing, blocks, user] = await Promise.all([
        this.googleApi.listAllEvents(client, calendarId),
        this.prisma.scheduleBlock.findMany({ where: { userId } }),
        this.prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } }),
      ]);
      const timeZone = user?.timezone || 'UTC';

      // Map existing Google events by the local block id we tagged them with.
      const eventByBlockId = new Map<string, calendar_v3.Schema$Event>();
      for (const ev of existing) {
        const bid = ev.extendedProperties?.private?.[BLOCK_ID_PROP];
        if (bid) eventByBlockId.set(bid, ev);
      }

      const liveBlockIds = new Set(blocks.map((b) => b.id));

      // Insert new / patch changed.
      for (const block of blocks) {
        const body = this.buildEvent(block, timeZone);
        if (!body) continue; // unmappable (e.g. end <= start)

        const ev = eventByBlockId.get(block.id);
        if (ev?.id) {
          await this.googleApi.patchEvent(client, calendarId, ev.id, body);
          if (block.googleEventId !== ev.id) {
            await this.prisma.scheduleBlock.update({
              where: { id: block.id },
              data: { googleEventId: ev.id },
            });
          }
        } else {
          const created = await this.googleApi.insertEvent(client, calendarId, body);
          if (created.id) {
            await this.prisma.scheduleBlock.update({
              where: { id: block.id },
              data: { googleEventId: created.id },
            });
          }
        }
      }

      // Prune events whose block no longer exists.
      for (const ev of existing) {
        const bid = ev.extendedProperties?.private?.[BLOCK_ID_PROP];
        if (ev.id && bid && !liveBlockIds.has(bid)) {
          await this.googleApi.deleteEvent(client, calendarId, ev.id);
        }
      }
    } catch (err) {
      if (isInvalidGrant(err)) {
        await this.markStale(connection.id);
        return;
      }
      throw err;
    }
  }

  // Map a weekly block to a recurring Google event. Returns null if the block
  // can't be represented (bad/zero-length time range).
  private buildEvent(
    block: {
      id: string;
      title: string;
      startTime: string;
      endTime: string;
      dayOfWeek: number;
    },
    timeZone: string,
  ): calendar_v3.Schema$Event | null {
    const byday = BYDAY[block.dayOfWeek];
    if (!byday) return null;
    if (this.toMinutes(block.endTime) <= this.toMinutes(block.startTime)) return null;

    const date = this.nextDateForDay(timeZone, block.dayOfWeek);
    return {
      summary: block.title,
      start: { dateTime: `${date}T${block.startTime}:00`, timeZone },
      end: { dateTime: `${date}T${block.endTime}:00`, timeZone },
      recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${byday}`],
      extendedProperties: { private: { [BLOCK_ID_PROP]: block.id } },
    };
  }

  // The next calendar date (YYYY-MM-DD) landing on `dayOfWeek`, evaluated in
  // the user's timezone. Used as the recurrence anchor; the wall-clock time +
  // timeZone field let Google handle DST. Anchors to noon UTC of the local
  // date so day arithmetic never slips across a DST boundary.
  private nextDateForDay(timeZone: string, dayOfWeek: number): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    }).formatToParts(new Date());

    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const y = Number(get('year'));
    const m = Number(get('month'));
    const d = Number(get('day'));
    const todayDow = WEEKDAY_TO_DOW[get('weekday')] ?? 0;

    const delta = (dayOfWeek - todayDow + 7) % 7;
    const anchor = new Date(Date.UTC(y, m - 1, d, 12));
    anchor.setUTCDate(anchor.getUTCDate() + delta);

    const yy = anchor.getUTCFullYear();
    const mm = String(anchor.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(anchor.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }

  private toMinutes(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  }

  private clientFor(connection: {
    refreshCiphertext: Uint8Array;
    refreshIv: Uint8Array;
    refreshAuthTag: Uint8Array;
  }): OAuth2Client {
    const refreshToken = this.encryption.decrypt({
      ciphertext: Buffer.from(connection.refreshCiphertext),
      iv: Buffer.from(connection.refreshIv),
      authTag: Buffer.from(connection.refreshAuthTag),
    });
    return this.googleApi.clientFromRefreshToken(refreshToken);
  }

  private async markStale(connectionId: string): Promise<void> {
    await this.prisma.calendarConnection.update({
      where: { id: connectionId },
      data: { status: 'stale' },
    });
    this.logger.warn(`Connection ${connectionId} marked stale (invalid_grant)`);
  }
}
