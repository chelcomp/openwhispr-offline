const { BrowserWindow } = require("electron");
const debugLogger = require("./debugLogger");

// Handles the manual, user-initiated "start a meeting recording" flow (meeting
// hotkey / a deliberate click). Automatic meeting detection/notification was
// removed — see docs/specs/remove-meeting-auto-detection.md.
class ManualMeetingLauncher {
  constructor(windowManager, databaseManager) {
    this.windowManager = windowManager;
    this.databaseManager = databaseManager;
    this._meetingModeActive = false;
  }

  async startManualMeeting() {
    debugLogger.info("Starting manual meeting", {}, "meeting");

    this._meetingModeActive = true;

    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const defaultTitle = `Meeting ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const event = {
      id: `manual-${Date.now()}`,
      calendar_id: "__manual__",
      summary: defaultTitle,
      start_time: new Date().toISOString(),
      end_time: new Date(Date.now() + 3600000).toISOString(),
      is_all_day: 0,
      status: "confirmed",
      hangout_link: null,
      conference_data: null,
      organizer_email: null,
      attendees_count: 0,
    };

    const noteResult = this.databaseManager.saveNote(event.summary, "", "meeting");
    const meetingsFolder = this.databaseManager.getMeetingsFolder();

    if (!noteResult?.note?.id || !meetingsFolder?.id) {
      debugLogger.error(
        "Manual meeting failed — missing note or folder",
        { noteId: noteResult?.note?.id, folderId: meetingsFolder?.id },
        "meeting"
      );
      this._meetingModeActive = false;
      return;
    }

    this.broadcastToWindows("note-added", noteResult.note);

    await this.windowManager.queueMeetingNoteNavigation({
      noteId: noteResult.note.id,
      folderId: meetingsFolder.id,
      event,
      trigger: "hotkey",
    });
  }

  setMeetingModeActive(active) {
    this._meetingModeActive = active;
    debugLogger.info("Meeting mode active state changed", { active }, "meeting");
  }

  broadcastToWindows(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    });
  }
}

module.exports = ManualMeetingLauncher;
