export type Priority = 'low' | 'medium' | 'high' | 'urgent'
export type TaskStatus = 'todo' | 'in_progress' | 'done'
export type Theme = 'system' | 'light' | 'dark'

export interface User {
  id: string
  email: string
  display_name: string
  timezone: string
  theme: Theme
  default_reminder_minutes: number
  daily_digest_enabled: boolean
  daily_digest_hour: number
  has_calendar_feed: boolean
  created_at: string
}

export interface Task {
  id: string
  title: string
  description: string
  priority: Priority
  category: string | null
  status: TaskStatus
  due_at: string | null
  due_has_time: boolean
  scheduled_for: string | null
  remind_at: string | null
  reminder_sent_at: string | null
  completed_at: string | null
  estimated_minutes: number | null
  goal_id: string | null
  source: string
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

/** Fields a user can edit; also the payload shape of sync operations. */
export type TaskFields = Partial<
  Pick<
    Task,
    | 'title'
    | 'description'
    | 'priority'
    | 'category'
    | 'status'
    | 'due_at'
    | 'due_has_time'
    | 'scheduled_for'
    | 'remind_at'
    | 'estimated_minutes'
    | 'goal_id'
  >
>

export interface Goal {
  id: string
  title: string
  description: string
  target_date: string | null
  target_value: number | null
  current_value: number
  unit: string
  status: 'active' | 'completed' | 'archived'
  progress: number
  tasks_total: number
  tasks_done: number
  created_at: string
  updated_at: string
}

export interface NotificationItem {
  id: string
  task_id: string | null
  kind: string
  title: string
  body: string
  read_at: string | null
  created_at: string
}

export interface ActivityItem {
  id: number
  action: string
  entity_type: string
  entity_id: string | null
  summary: string
  created_at: string
}

export interface Page<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export interface ParsedTask {
  title: string
  priority: Priority
  category: string | null
  due_at: string | null
  due_has_time: boolean
  remind_at: string | null
  duplicate_of: Task | null
}

export interface ParseResult {
  tasks: ParsedTask[]
  parser: 'llm' | 'rules'
  warnings: string[]
}

export interface CommandResult {
  intent: 'create_task' | 'complete_task' | 'navigate' | 'summary' | 'unknown'
  message: string
  navigate_to: string | null
  tasks: Task[]
  candidates: Task[]
}

export interface PrioritizedTask {
  task: Task
  score: number
  reasons: string[]
}

export interface PrioritizeResult {
  items: PrioritizedTask[]
  focus_note: string | null
  generated_by: 'llm' | 'rules'
}

export interface SummaryResult {
  period: 'day' | 'week' | 'month'
  start: string
  end: string
  stats: Record<string, number | string | null>
  highlights: string[]
  narrative: string
  generated_by: 'llm' | 'rules'
}

export interface InsightsResult {
  insights: string[]
  generated_by: 'llm' | 'rules'
  based_on_days: number
}

export interface AIStatus {
  enabled: boolean
  available: boolean
  model: string
  model_installed: boolean
}

export interface Overview {
  days: number
  start: string
  end: string
  series: { date: string; created: number; completed: number }[]
  created_total: number
  completed_total: number
  completion_ratio: number | null
  on_time_rate: number | null
  open_total: number
  overdue_total: number
  streak_days: number
  by_category: { category: string; open: number; done: number }[]
  open_by_priority: Record<Priority, number>
  completions_by_weekday: { weekday: string; count: number }[]
  completions_by_hour: { hour: number; count: number }[]
  goals: { id: string; title: string; progress: number; status: string }[]
}

export interface SyncOp {
  op_id: string
  kind: 'upsert' | 'delete'
  task_id: string
  base_version: number | null
  data: TaskFields & { deleted?: boolean }
  /** Monotonic local sequence used to preserve order. */
  seq: number
}

export interface SyncOpResult {
  op_id: string
  status: 'applied' | 'conflict' | 'duplicate' | 'rejected'
  task: Task | null
  error: string | null
}

export interface SyncConflict {
  task_id: string
  kind: 'upsert' | 'delete'
  local: TaskFields & { deleted?: boolean }
  server: Task | null
  message: string
  detected_at: string
}
