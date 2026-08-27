// server/room.mjs — thin re-export of the shared browser-safe reducer.
//
// The single source of truth for the `sg.mp.v1` reducer is
// `site/js/organs/garden/room-core.js` (Wave-5 §1, frozen contract: the SAME
// file is loaded by this Node relay and by the elected browser host, byte-
// identical, no shimmed duplicate to drift). This file exists only as the
// module path every existing import in server/ already uses
// (`from '../room.mjs'` and `from './room.mjs'`); importing the shared core
// here keeps every call site working without churn, and keeps the spec
// invariants (pure reducer, no I/O, no Date.now) enforced in one place.
//
// Anything new should import from this file's path, which forwards to
// room-core — do NOT add reducer logic here.

export {
  PROTOCOL,
  LEASE_TTL_MS,
  POSE_HZ,
  MAX_MEMBERS,
  MAX_ROOMS,
  MAX_BODY_BYTES,
  HEARTBEAT_MS,
  TUNE_NAME_RE,
  TUNE_VALUE_MAX_ABS,
  createRoom,
  reduce,
  tick,
  removeMember,
} from '../site/js/organs/garden/room-core.js';