export type Role = "admin" | "barista";
export type PayType = "hourly" | "shift";
export type ShiftStatus =
  "planned" | "confirmed" | "worked" | "closed" | "cancelled";
export interface User {
  id: string;
  name: string;
  phone: string;
  role: Role;
  active: boolean;
  rate: string | null;
  pay_type: PayType;
  version: number;
  must_change_password: boolean;
  avatar_url?: string | null;
}
export interface ShiftType {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  pay_type: PayType;
  rate: string;
  allow_exchange: boolean;
  active: boolean;
  version: number;
}
export interface Shift {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  user_id: string | null;
  user_name: string | null;
  user_avatar_url?: string | null;
  type_id: string;
  type_name: string;
  status: ShiftStatus;
  minutes?: number;
  pay_type?: PayType;
  rate?: string;
  amount?: string;
  comment?: string;
  version: number;
  exchange_id: string | null;
  exchanged: boolean;
  exchange_locked: boolean;
  exchange_allowed: boolean;
  closes_at: string;
  start_at: string;
  end_at: string;
  adjustment_minutes?: number;
  adjustment_amount?: string;
}
export interface Listing {
  id: string;
  shift_id: string;
  date: string;
  start_time: string;
  end_time: string;
  type_name: string;
  user_id: string;
  user_name: string;
  user_avatar_url?: string | null;
  status: string;
  taken_by: string | null;
  taken_name: string | null;
  closes_at: string;
  version: number;
}
export interface Notice {
  id: string;
  title: string;
  body: string;
  category: string;
  link: string;
  read_at: string | null;
  created_at: string;
}
export interface PayrollRow {
  user_id: string;
  name: string;
  date: string;
  minutes: number;
  amount: string;
  planned_minutes: number;
  planned_amount: string;
}
export interface Audit {
  id: string;
  actor_name: string;
  action: string;
  entity: string;
  entity_id: string | null;
  reason: string | null;
  created_at: string;
  before_value: unknown;
  after_value: unknown;
}
export const statusLabels: Record<ShiftStatus, string> = {
  planned: "Запланирована",
  confirmed: "Подтверждена",
  worked: "Отработана",
  closed: "Закрыта",
  cancelled: "Отменена",
};
