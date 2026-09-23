import { createContext, useContext } from 'react';
import type { MetaResponse, ReservationDTO, Kind } from '../shared/types';
export type BookingDraft = { berthId?: string; startDate?: string; endDate?: string; vesselId?: string | null; kind?: Kind; title?: string | null; notes?: string | null; id?: string };
export type FindDraft = { start?: string; end?: string; lengthFt?: number; vesselId?: string };
export interface AppState {
  meta: MetaResponse;
  newBooking: (draft?: BookingDraft) => void;
  showBooking: (id: string) => void;
  editBooking: (booking: ReservationDTO) => void;
  findBerth: (draft?: FindDraft) => void;
  notify: (message: string) => void;
  selectedLength: number | null;
  setSelectedLength: (length: number | null) => void;
}
export const AppContext = createContext<AppState | null>(null);
export const useApp = () => { const value = useContext(AppContext); if (!value) throw new Error('App context is missing'); return value; };
