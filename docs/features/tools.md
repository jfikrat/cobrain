# MCP Tools Reference

Cobrain uses MCP (Model Context Protocol) tools to extend its capabilities. This document lists all available tools and their usage.

## Overview

Tools are organized into categories:

- **Memory Tools**: Store and retrieve information
- **Goal Tools**: Manage goals and reminders
- **Persona Tools**: Customize AI personality
- **Google Drive Tools**: Cloud storage integration
- **Standard Tools**: File operations, web access

## Memory Tools

### `remember`

Stores information in memory.

**Input:**
```typescript
{
  content: string       // The information to store
  type?: "episodic" | "semantic" | "procedural"  // Default: auto-detect
  importance?: number   // 0.0 - 1.0, default: 0.5
  tags?: string[]       // Keywords for search
}
```

**Output:**
```typescript
{
  id: number
  success: boolean
  summary: string      // AI-generated summary
  expiresAt?: string   // For episodic memories
}
```

**Example:**
```
Tool: remember
Input: {
  content: "User's birthday is March 15th",
  type: "semantic",
  importance: 0.8,
  tags: ["birthday", "personal", "march"]
}
```

### `recall`

Searches stored memories.

**Input:**
```typescript
{
  query: string        // Search query
  limit?: number       // Max results, default: 5
  type?: string        // Filter by memory type
}
```

**Output:**
```typescript
{
  memories: Array<{
    id: number
    content: string
    summary: string
    type: string
    importance: number
    similarity: number  // Search relevance score
    createdAt: string
  }>
  totalMatches: number
}
```

**Example:**
```
Tool: recall
Input: { query: "birthday", limit: 3 }
```

### `memory_stats`

Returns memory statistics.

**Input:** None

**Output:**
```typescript
{
  total: number
  byType: {
    episodic: number
    semantic: number
    procedural: number
  }
  averageImportance: number
  oldestMemory: string
  newestMemory: string
  expiringCount: number
}
```

## Goal Tools

### `create_goal`

Creates a new goal.

**Input:**
```typescript
{
  title: string
  description?: string
  priority?: number    // 0-10, default: 5
  dueDate?: string     // ISO date format
}
```

**Output:**
```typescript
{
  id: number
  success: boolean
  goal: Goal
}
```

### `list_goals`

Lists all goals.

**Input:**
```typescript
{
  includeCompleted?: boolean  // Default: false
}
```

**Output:**
```typescript
{
  goals: Goal[]
  total: number
}
```

### `complete_goal`

Marks a goal as completed.

**Input:**
```typescript
{
  goalId: number
}
```

**Output:**
```typescript
{
  success: boolean
  completedAt: string
}
```

### `delete_goal`

Deletes a goal.

**Input:**
```typescript
{
  goalId: number
}
```

**Output:**
```typescript
{
  success: boolean
}
```

### `create_reminder`

Creates a reminder.

**Input:**
```typescript
{
  title: string
  message?: string
  triggerAt: string      // ISO datetime
  repeatPattern?: string // Cron pattern
}
```

**Output:**
```typescript
{
  id: number
  success: boolean
}
```

### `list_reminders`

Lists all reminders.

**Input:** None

**Output:**
```typescript
{
  reminders: Reminder[]
  total: number
}
```

## Persona Tools

### `get_persona`

Gets current persona configuration.

**Input:** None

**Output:**
```typescript
{
  identity: {...}
  voice: {...}
  behavior: {...}
  boundaries: {...}
  userContext: {...}
  version: number
  updatedAt: string
}
```

### `update_persona`

Updates a persona field (requires user approval).

**Input:**
```typescript
{
  field: string        // e.g., "voice.tone"
  value: any           // New value
  reason: string       // Why this change
}
```

**Output:**
```typescript
{
  success: boolean
  previousValue: any
  newValue: any
  version: number
}
```

### `evolve_persona`

Suggests persona evolution based on patterns.

**Input:**
```typescript
{
  suggestions: Array<{
    field: string
    value: any
    confidence: number  // 0.0 - 1.0
  }>
}
```

**Output:**
```typescript
{
  prompted: boolean    // User was asked to approve
}
```

### `persona_snapshots`

Lists persona version snapshots.

**Input:**
```typescript
{
  limit?: number  // Default: 10
}
```

**Output:**
```typescript
{
  snapshots: Array<{
    id: number
    version: number
    milestone: string
    createdAt: string
  }>
}
```

## Google Drive Tools

### `gdrive_list`

Lists files in Google Drive.

**Input:**
```typescript
{
  path?: string        // Folder path, default: root
  limit?: number       // Max results
}
```

**Output:**
```typescript
{
  files: Array<{
    id: string
    name: string
    mimeType: string
    size: number
    modifiedAt: string
  }>
}
```

### `gdrive_download`

Downloads a file from Google Drive.

**Input:**
```typescript
{
  fileId: string
  localPath?: string   // Where to save
}
```

**Output:**
```typescript
{
  success: boolean
  localPath: string
  size: number
}
```

### `gdrive_upload`

Uploads a file to Google Drive.

**Input:**
```typescript
{
  localPath: string
  remotePath?: string  // Destination folder
  name?: string        // Override filename
}
```

**Output:**
```typescript
{
  success: boolean
  fileId: string
  webLink: string
}
```

### `gdrive_link`

Creates a shareable link.

**Input:**
```typescript
{
  fileId: string
  access?: "view" | "comment" | "edit"
}
```

**Output:**
```typescript
{
  link: string
  access: string
}
```

## Standard Tools

These are standard Claude tools available in all Claude Code sessions:

### `Read`

Reads file contents.

### `Write`

Writes content to a file.

### `Edit`

Edits part of a file.

### `Glob`

Finds files by pattern.

### `Grep`

Searches file contents.

### `WebSearch`

Searches the web.

### `WebFetch`

Fetches URL content.

### `Bash`

Executes shell commands.

## Permission Levels

Tools are categorized by danger level:

### Safe (Auto-approved in smart mode)

- `Read`, `Glob`, `Grep`
- `WebSearch`, `WebFetch`
- `recall`, `memory_stats`
- `list_goals`, `list_reminders`
- `get_persona`, `persona_snapshots`
- `gdrive_list`

### Requires Approval

- `Write`, `Edit`
- `remember` (storing data)
- `create_goal`, `complete_goal`, `delete_goal`
- `create_reminder`
- `update_persona`, `evolve_persona`
- `gdrive_upload`, `gdrive_download`

### Dangerous (Always requires approval in strict mode)

- `Bash` with destructive commands
- File deletion operations
- System modifications

## Error Handling

All tools return errors in a consistent format:

```typescript
{
  error: true
  message: string
  code?: string
}
```

Common error codes:
- `NOT_FOUND`: Resource doesn't exist
- `PERMISSION_DENIED`: User denied approval
- `INVALID_INPUT`: Bad input parameters
- `TIMEOUT`: Operation timed out

## Tool Response Format

Tools use a standardized response format:

```typescript
// Success
{
  result: any,
  metadata?: {
    duration: number,
    cached: boolean
  }
}

// Error
{
  error: true,
  message: string,
  code?: string
}
```

## Best Practices

### For Users

1. **Review tool requests**: Especially in smart mode
2. **Understand what tools do**: Read descriptions before approving
3. **Use appropriate modes**: Strict for sensitive environments

### For AI

1. **Explain before using**: Tell user what you're about to do
2. **Handle errors gracefully**: Provide helpful error messages
3. **Batch when possible**: Combine related operations
4. **Respect boundaries**: Don't retry denied operations
