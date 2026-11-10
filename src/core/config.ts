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

  challenge: {
    // Sudden brake: hits once, somewhere in this window after the train leaves.
    brakeWindow: [0.8, 2.0],
    brakeAccel: 13,
    brakeDuration: 0.55,
    brakeStun: 0.6, // for anyone standing still when it hits
    // Standing passengers (crowd) and passengers boarding at one-side doors.
    crowdCount: 4,
    boardingCount: 3,
    standerRadius: 0.3,
    standerSpeed: 0.8,
    // Kick fight: kick a seated player off their seat (from in front of it).
    kickRange: 0.85,
    kickStun: 0.9,
    kickCooldown: 2,
    // Wet floor: how quickly you can change direction inside a puddle (normal is 12).
    puddleCount: 3,
    puddleRadius: [0.6, 0.9],
    puddleGrip: 1.6,
  },

  points: {
    round: 10, // seated when the doors close
    win: 50,
    kick: 5, // kicked someone off a seat
  },

  powerUp: {
    pickRange: 0.6,
    shieldTime: 4,
  },
} as const;

/**
 * Commuter Line Bogor (red line), from Bogor to Jakarta Kota, with the Nambo
 * branch joining at Citayam. Stations without service on the map (Gambir,
 * Sukaresmi, Pondok Rajeg, Gunung Putri) are left out.
 */
export const BOGOR_LINE = [
  'Bogor',
  'Cilebut',
  'Bojong Gede',
  'Citayam',
  'Depok',
  'Depok Baru',
  'Pondok Cina',
  'Univ. Indonesia',
  'Univ. Pancasila',
  'Lenteng Agung',
  'Tanjung Barat',
  'Pasar Minggu',
  'Pasar Minggu Baru',
  'Duren Kalibata',
  'Cawang',
  'Tebet',
  'Manggarai',
  'Cikini',
  'Gondangdia',
  'Juanda',
  'Sawah Besar',
  'Mangga Besar',
  'Jayakarta',
  'Jakarta Kota',
] as const;

/** Nambo branch up to where it joins the main line (Citayam onwards is BOGOR_LINE). */
export const NAMBO_BRANCH = ['Nambo', 'Cibinong'] as const;

/** Every station a game can stop at. */
export const STATIONS: readonly string[] = [...NAMBO_BRANCH, ...BOGOR_LINE];

/** Stops in one game's journey (more than any game needs; it wraps if replays run long). */
export const ROUTE_LENGTH = 8;
