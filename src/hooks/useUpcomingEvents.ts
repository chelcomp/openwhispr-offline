import type { CalendarEvent } from "../types/calendar";

export interface UseUpcomingEventsReturn {
  events: CalendarEvent[];
  isLoading: boolean;
  isConnected: boolean;
}

export function useUpcomingEvents(): UseUpcomingEventsReturn {
  return { events: [], isLoading: false, isConnected: false };
}
