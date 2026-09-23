import type { Alternatives, ReservationDTO } from '../shared/types';

export class ApiError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 422 | 500,
    public code: string,
    message: string,
    public conflicts: ReservationDTO[] = [],
    public alternatives: Alternatives = { berths: [], dateShifts: [] },
  ) { super(message); }
}

export const missing = (entity: string) => new ApiError(404, 'NOT_FOUND', `${entity} was not found.`);
