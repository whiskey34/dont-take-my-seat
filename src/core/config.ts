/** All tunable numbers live here. Units: metres and seconds. */
export const CONFIG = {
  tickRate: 60,
  maxPlayers: 4,

  car: {
    halfLength: 11.6, // walkable x range is [-halfLength, halfLength]
    aisleHalfWidth: 1.4, // walkable z range is [-aisleHalfWidth, aisleHalfWidth]
    seatZ: 1.85, // where a seated body sits
    seatFrontZ: 1.25, // where you stand to sit down
    seatWidth: 0.8,
    doorsX: [-8, 0, 8],
    doorHalfWidth: 1.2,
    polesX: [-10, -4, 4, 10],
    poleRadius: 0.07,
  },

  player: {
    radius: 0.34,
    speed: 4.2,
    responsiveness: 12, // how quickly velocity follows the stick
  },

  push: {
    range: 0.95, // centre-to-centre distance
    impulse: 7,
    cooldown: 0.9,
    stun: 0.45,
  },

  sitRange: 0.7,
  priorityKickDelay: 1.1,
  priorityKickStun: 0.6,

  phase: {
    intro: 2.5,
    riding: 3.6,
    braking: 1.2, // last part of riding
    scramble: 8,
    result: 2.6,
  },

  sway: { amp: 1.4, freq: 0.85 },
  brakeAccel: 5.5,
} as const;

export const STATIONS = [
  'Depok Baru',
  'Pasar Minggu',
  'Manggarai',
  'Sudirman',
  'Tanah Abang',
  'Duri',
  'Jakarta Kota',
] as const;
