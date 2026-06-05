import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GoogleCalendarController } from './google-calendar.controller';
import { CalendarPushService } from './services/calendar-push.service';
import { CalendarSyncService } from './services/calendar-sync.service';
import { GoogleApiService } from './services/google-api.service';
import { GoogleCalendarService } from './services/google-calendar.service';

// AuthModule provides JwtAuthGuard (via JwtModule) and the JwtService used to
// sign/verify the OAuth `state`. PrismaService + EncryptionService are global.
// CalendarPushService is exported so ScheduleModule can trigger a push
// reconcile whenever schedule blocks change.
@Module({
  imports: [AuthModule],
  controllers: [GoogleCalendarController],
  providers: [
    GoogleApiService,
    GoogleCalendarService,
    CalendarSyncService,
    CalendarPushService,
  ],
  exports: [CalendarSyncService, CalendarPushService],
})
export class GoogleCalendarModule {}
