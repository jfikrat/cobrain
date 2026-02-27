# Memory System

Cobrain's memory system enables the AI to remember information across conversations, providing context and personalization. It consists of multiple layers designed for different types of information.

## Memory Types

### Episodic Memory

**What**: Events, conversations, specific occurrences
**Duration**: 90 days (configurable)
**Example**: "Had a meeting with Ahmet on January 15th about the project"

Episodic memories are time-bound and automatically expire. They capture specific events and interactions.

### Semantic Memory

**What**: Facts, knowledge, general truths
**Duration**: Permanent
**Example**: "Ahmet's favorite programming language is TypeScript"

Semantic memories store factual information that doesn't expire. These form the knowledge base about you and your world.

### Procedural Memory

**What**: How-to knowledge, processes, preferences
**Duration**: Permanent
**Example**: "When sending reports to the team, always include a summary at the top"

Procedural memories store learned behaviors and processes.

## Memory Structure

Each memory contains:

```typescript
{
  id: number
  type: "episodic" | "semantic" | "procedural"
  content: string           // Full text
  summary: string           // AI-generated short form
  tags: string[]            // Keywords for search
  importance: number        // 0.0 - 1.0
  accessCount: number       // How often retrieved
  lastAccessedAt: Date
  source: string            // telegram, web, whatsapp
  sourceRef?: string        // Message ID reference
  metadata: object          // Custom fields
  createdAt: Date
  expiresAt?: Date          // For episodic only
}
```

## Storing Memories

### Automatic Storage

Cobrain automatically stores important information from conversations:

```
User: My birthday is on March 15th

Cobrain: I'll remember that your birthday is March 15th!
         [Memory stored: semantic, importance: 0.8]
```

### Explicit Storage

Ask Cobrain to remember something specific:

```
User: Remember that the project deadline is February 28th

Cobrain: Noted! I've saved that the project deadline is February 28th.
         [Memory stored: episodic, expires: May 28th]
```

### Via Tool

The AI uses the `remember` tool:

```typescript
Tool: remember
Input: {
  content: "Project deadline is February 28th",
  type: "episodic",
  importance: 0.9,
  tags: ["project", "deadline", "february"]
}
```

## Retrieving Memories

### Automatic Retrieval

Cobrain automatically searches memories when relevant:

```
User: When is my birthday?

Cobrain: Your birthday is on March 15th.
         [Retrieved from memory: id=42]
```

### Explicit Search

Ask Cobrain to search memories:

```
User: What do you remember about the project?

Cobrain: Here's what I remember about the project:
         - Deadline is February 28th (saved Jan 20)
         - Ahmet is the project lead (saved Jan 15)
         - Uses TypeScript and React (saved Jan 10)
```

### Via Tool

The AI uses the `recall` tool:

```typescript
Tool: recall
Input: {
  query: "project deadline",
  limit: 5,
  type: "episodic"  // optional filter
}

Output: [
  { id: 42, content: "Project deadline is February 28th", similarity: 0.95 },
  { id: 38, content: "Project kickoff meeting on January 10th", similarity: 0.72 }
]
```

## Memory Architecture

### FileMemory (Long-term)

Two Markdown files per user under `~/.cobrain/users/<id>/memory/`:

- **facts.md** — Permanent facts organized by section (overwrite semantics)
- **events.md** — Dated event log (append semantics), archived after 90 days

### Recall

`recall` tool performs full-text search across facts.md and recent events (30 days by default).

## Memory Management

### View Statistics

```
User: /memory stats

📊 Memory Statistics

Total: 156 memories
- Episodic: 89 (57%)
- Semantic: 52 (33%)
- Procedural: 15 (10%)

Access Patterns:
- Most accessed: "Birthday is March 15th" (12 times)
- Least accessed: "Met John at conference" (1 time)

Storage: 2.3 MB
Expiring soon: 5 memories (next 7 days)
```

### Prune Expired

Clean up old episodic memories:

```
User: /memory prune

🧹 Memory Cleanup

Removed: 12 expired episodic memories
Freed: 0.5 MB

Remaining: 144 memories
```

### Manual Deletion

Remove specific memories:

```
User: Forget that I mentioned my old phone number

Cobrain: I've removed the memory about your phone number.
         [Deleted: 1 memory]
```

## Importance Levels

| Range | Level | Description |
|-------|-------|-------------|
| 0.0-0.3 | Low | Casual mentions, temporary info |
| 0.3-0.6 | Medium | Useful context, preferences |
| 0.6-0.8 | High | Important facts, key dates |
| 0.8-1.0 | Critical | Essential info, must remember |

Importance affects:
- Search result ranking
- Expiration priority (low importance expires first)
- Context inclusion probability

## MCP Tools

### `remember`

Stores new information in memory.

```typescript
// Input:
{
  content: "User prefers dark mode in all applications",
  type: "semantic",
  importance: 0.7,
  tags: ["preference", "ui", "dark-mode"]
}

// Output:
{
  id: 157,
  success: true,
  summary: "Prefers dark mode",
  expiresAt: null  // semantic = permanent
}
```

### `recall`

Searches existing memories.

```typescript
// Input:
{
  query: "UI preferences",
  limit: 5,
  type: "semantic"  // optional
}

// Output:
{
  memories: [
    { id: 157, content: "...", similarity: 0.92 },
    { id: 134, content: "...", similarity: 0.78 }
  ],
  totalMatches: 3
}
```

### `memory_stats`

Returns memory statistics.

```typescript
// Input: none
// Output:
{
  total: 156,
  byType: { episodic: 89, semantic: 52, procedural: 15 },
  averageImportance: 0.58,
  oldestMemory: "2024-01-01",
  newestMemory: "2024-01-25",
  expiringCount: 5
}
```

## Configuration

### Environment Variables

```env
# Memory retention (days)
MAX_MEMORY_AGE_DAYS=90
```

## Best Practices

### For Users

1. **Be Specific**: "Remember my dentist appointment on Feb 10 at 2pm" is better than "I have a dentist appointment"
2. **Correct Mistakes**: "Actually, my birthday is March 16th, not 15th"
3. **Review Periodically**: Check what Cobrain remembers with `/memory stats`

### For the AI

1. **Extract Key Information**: Store facts, not entire conversations
2. **Assign Appropriate Types**: Events → episodic, Facts → semantic
3. **Generate Good Tags**: Multiple relevant keywords
4. **Set Realistic Importance**: Don't over-inflate importance scores

## Technical Details

### Storage

Per-user Markdown files:

```
~/.cobrain/users/<id>/memory/
├── facts.md        # Permanent facts (sections, overwrite)
├── events.md       # Dated event log (append)
└── archive/        # Events older than 90 days (YYYY-MM-events.md)
```

### Consolidation

Mneme agent runs nightly (03:00) using `claude-opus-4-6`:
- Archives events older than 90 days
- Extracts patterns from recent events → new facts
- Resolves conflicting facts
