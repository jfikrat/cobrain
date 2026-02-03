# Goals & Reminders

Cobrain helps you track goals and reminds you about important tasks. This system enables autonomous operation, allowing Cobrain to proactively assist you.

## Goals

### What is a Goal?

A goal is a tracked objective with:
- Title and description
- Priority level (0-10)
- Due date (optional)
- Progress tracking (0-100%)
- Status management

### Creating Goals

#### Via Chat

```
User: Create a goal to learn TypeScript

Cobrain: I've created a new goal:

         📎 Learn TypeScript
         Priority: 5 (medium)
         Status: Active

         Want to add a due date or description?
```

#### With Details

```
User: Create a goal: Complete the quarterly report
       Due: February 28
       Priority: High
       Description: Include sales data and projections

Cobrain: Created goal with all details:

         📎 Complete the quarterly report
         Due: Feb 28, 2024
         Priority: 8 (high)
         Status: Active
```

#### Via Telegram

```
/goals → [Create Goal] → Enter details
```

### Goal Structure

```typescript
{
  id: number
  title: string
  description?: string
  status: "active" | "completed" | "abandoned" | "paused"
  priority: number      // 0-10
  dueDate?: Date
  progress: number      // 0.0 - 1.0
  metadata: object      // Custom fields
  createdAt: Date
  updatedAt: Date
}
```

### Managing Goals

#### List Goals

```
User: Show my goals

Cobrain: 📋 Your Goals

         Active:
         1. [■■■□□] Complete quarterly report (Due: Feb 28)
            Priority: High | Progress: 60%

         2. [■□□□□] Learn TypeScript
            Priority: Medium | Progress: 20%

         Completed:
         3. ✅ Set up project repository (Jan 15)
```

#### Update Progress

```
User: Update quarterly report progress to 80%

Cobrain: Updated "Complete quarterly report":
         Progress: 60% → 80%

         Almost there! 🎯
```

#### Complete Goal

```
User: I finished the quarterly report

Cobrain: 🎉 Congratulations!

         Completed: "Complete quarterly report"
         Duration: 14 days
         Final progress: 100%
```

#### Abandon Goal

```
User: Abandon the TypeScript goal

Cobrain: Understood. I've marked "Learn TypeScript" as abandoned.

         Want to tell me why? This helps me understand
         your priorities better.
```

### Priority Levels

| Level | Value | Description |
|-------|-------|-------------|
| Critical | 9-10 | Must complete, highest urgency |
| High | 7-8 | Important, should prioritize |
| Medium | 4-6 | Standard importance |
| Low | 1-3 | Nice to have, can wait |

### Goal Statuses

| Status | Description |
|--------|-------------|
| active | Currently working on |
| paused | Temporarily on hold |
| completed | Successfully finished |
| abandoned | Decided not to pursue |

## Reminders

### What is a Reminder?

A reminder is a time-triggered notification with:
- Title and message
- Trigger time
- Optional repeat pattern

### Creating Reminders

#### Simple Reminder

```
User: Remind me to call mom tomorrow at 6pm

Cobrain: ⏰ Reminder set:

         "Call mom"
         When: Tomorrow at 6:00 PM

         I'll send you a notification then.
```

#### With Message

```
User: Remind me at 9am on Monday to submit the report
      with message "Don't forget the attachments"

Cobrain: ⏰ Reminder set:

         "Submit the report"
         When: Monday, 9:00 AM
         Message: Don't forget the attachments
```

#### Recurring Reminder

```
User: Remind me every Friday at 5pm to write weekly summary

Cobrain: ⏰ Recurring reminder set:

         "Write weekly summary"
         When: Every Friday at 5:00 PM
         Pattern: Weekly

         First reminder: This Friday
```

### Reminder Structure

```typescript
{
  id: number
  title: string
  message?: string
  triggerAt: Date
  repeatPattern?: string   // Cron pattern
  status: "pending" | "sent" | "snoozed" | "cancelled"
  createdAt: Date
}
```

### Managing Reminders

#### List Reminders

```
User: Show my reminders

Cobrain: ⏰ Your Reminders

         Upcoming:
         1. Call mom - Tomorrow 6:00 PM
         2. Submit report - Monday 9:00 AM
         3. Weekly summary - Friday 5:00 PM (recurring)

         Past:
         4. ✓ Team meeting - Today 2:00 PM (sent)
```

#### Cancel Reminder

```
User: Cancel the call mom reminder

Cobrain: Cancelled reminder: "Call mom"
```

#### Snooze Reminder

When a reminder triggers:

```
🔔 Reminder: Call mom

[Snooze 15min] [Snooze 1hr] [Done]
```

### Repeat Patterns

Supported patterns:

| Pattern | Description |
|---------|-------------|
| `0 9 * * MON` | Every Monday at 9 AM |
| `0 17 * * FRI` | Every Friday at 5 PM |
| `0 8 * * *` | Every day at 8 AM |
| `0 9 1 * *` | 1st of every month at 9 AM |

## MCP Tools

### `create_goal`

Creates a new goal.

```typescript
// Input:
{
  title: "Learn TypeScript",
  description: "Complete the official handbook",
  priority: 6,
  dueDate: "2024-03-01"
}

// Output:
{
  id: 5,
  success: true,
  goal: { ... }
}
```

### `list_goals`

Lists all goals.

```typescript
// Input:
{
  includeCompleted: false  // optional
}

// Output:
{
  goals: [
    { id: 5, title: "Learn TypeScript", status: "active", progress: 0.2 },
    { id: 3, title: "Quarterly report", status: "active", progress: 0.8 }
  ],
  total: 2
}
```

### `complete_goal`

Marks a goal as completed.

```typescript
// Input:
{
  goalId: 3
}

// Output:
{
  success: true,
  completedAt: "2024-01-25T10:00:00Z"
}
```

### `create_reminder`

Creates a new reminder.

```typescript
// Input:
{
  title: "Call mom",
  message: "Ask about weekend plans",
  triggerAt: "2024-01-26T18:00:00",
  repeatPattern: null  // one-time
}

// Output:
{
  id: 12,
  success: true
}
```

### `list_reminders`

Lists all reminders.

```typescript
// Input: none

// Output:
{
  reminders: [
    { id: 12, title: "Call mom", triggerAt: "...", status: "pending" }
  ],
  total: 1
}
```

## Autonomous Features

When `ENABLE_AUTONOMOUS=true`, Cobrain:

### Daily Goal Check

Automatic morning summary (configurable time):

```
🌅 Good morning!

Today's Focus:
- Complete quarterly report (Due: 3 days)
  Progress: 80% → Suggested: Review and finalize

Upcoming:
- Learn TypeScript (Due: 35 days)

Reminders today:
- 6:00 PM: Call mom
```

### Progress Prompts

Periodic check-ins on active goals:

```
📊 Goal Check: Complete quarterly report

It's been 3 days since your last update.
Current progress: 80%

How's it going? [Update Progress] [On Track] [Need Help]
```

### Due Date Warnings

Advance notification before deadlines:

```
⚠️ Due Date Approaching

"Complete quarterly report" is due in 2 days.
Current progress: 80%

Would you like to:
[Focus on this today] [Extend deadline] [Mark complete]
```

## Scheduler

The scheduler handles:

1. **Reminder Triggers**: Sends notifications at the right time
2. **Goal Checks**: Daily summary and progress prompts
3. **Memory Pruning**: Cleans expired memories
4. **Daily Summaries**: WhatsApp pending messages summary

### Configuration

Scheduler runs when `ENABLE_AUTONOMOUS=true`.

Scheduled tasks are stored in the global database:

```sql
scheduled_tasks:
- task_type: "reminder"
- schedule: "0 18 26 1 *"  (Jan 26 at 6 PM)
- enabled: true
```

## Best Practices

### Goals

1. **Be Specific**: "Learn TypeScript basics" vs "Learn programming"
2. **Set Realistic Deadlines**: Give yourself enough time
3. **Update Progress**: Regular updates help Cobrain assist better
4. **Review Regularly**: Check `/goals` weekly

### Reminders

1. **Include Context**: Add messages with relevant details
2. **Use Recurring**: For routine tasks, set up repeating reminders
3. **Snooze Wisely**: Don't over-snooze; reschedule if needed
4. **Clean Up**: Cancel reminders you no longer need
