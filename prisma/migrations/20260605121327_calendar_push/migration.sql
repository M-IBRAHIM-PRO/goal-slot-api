-- AlterTable
ALTER TABLE "CalendarConnection" ADD COLUMN     "pushEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ScheduleBlock" ADD COLUMN     "googleEventId" TEXT;
