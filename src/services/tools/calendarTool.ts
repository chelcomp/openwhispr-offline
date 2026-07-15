import type { ToolDefinition, ToolResult } from "./ToolRegistry";

type TimeRange = "today" | "tomorrow" | "week";

function getWindowMinutes(timeRange: TimeRange): number {
  if (timeRange === "week") return 10080;

  const now = new Date();
  if (timeRange === "tomorrow") {
    const endOfTomorrow = new Date(now);
    endOfTomorrow.setDate(endOfTomorrow.getDate() + 1);
    endOfTomorrow.setHours(23, 59, 59, 999);
    return Math.ceil((endOfTomorrow.getTime() - now.getTime()) / 60000);
  }

  // "today": remaining minutes until midnight
  const midnight = new Date(now);
  midnight.setHours(23, 59, 59, 999);
  return Math.max(1, Math.ceil((midnight.getTime() - now.getTime()) / 60000));
}

export const calendarTool: ToolDefinition = {
  name: "get_calendar_events",
  description:
    "Get upcoming Google Calendar events for a given time range. Returns event summaries, times, and locations.",
  parameters: {
    type: "object",
    properties: {
      timeRange: {
        type: "string",
        enum: ["today", "tomorrow", "week"],
        description: 'Time range to fetch events for (default "today")',
      },
    },
    required: [],
    additionalProperties: false,
  },
  readOnly: true,

  async execute(_args: Record<string, unknown>): Promise<ToolResult> {
    return {
      success: true,
      data: [],
      displayText: "Google Calendar integration is not available in this version.",
    };
  },
};
