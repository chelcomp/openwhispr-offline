import type { ToolDefinition, ToolResult } from "./ToolRegistry";

const MAX_CONTENT_LENGTH = 500;

interface SearchToolOptions {
  useCloudSearch: boolean;
}

export function createSearchNotesTool(options: SearchToolOptions): ToolDefinition {
  const { useCloudSearch } = options;

  return {
    name: "search_notes",
    description:
      "Search the user's notes using keyword matching. Returns matching notes with title, date, and a preview of content.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to find relevant notes",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default 5)",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    readOnly: true,

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const query = args.query as string;
      const limit = typeof args.limit === "number" ? args.limit : 5;

      try {
        return await executeLocalSearch(query, limit);
      } catch (error) {
        return {
          success: false,
          data: null,
          displayText: `Failed to search notes: ${(error as Error).message}`,
        };
      }
    },
  };
}

async function executeLocalSearch(query: string, limit: number): Promise<ToolResult> {
  const notes = await window.electronAPI.searchNotes(query, limit);

  if (notes.length === 0) {
    return {
      success: true,
      data: [],
      displayText: `No notes found for "${query}"`,
    };
  }

  const results = notes.map((note) => ({
    id: note.id,
    title: note.title,
    date: note.created_at,
    type: note.note_type,
    content: (note.enhanced_content || note.content).slice(0, MAX_CONTENT_LENGTH),
  }));

  return {
    success: true,
    data: results,
    displayText: `Found ${results.length} note${results.length === 1 ? "" : "s"} for "${query}"`,
  };
}


