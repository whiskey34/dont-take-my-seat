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
    // Wet floor: running onto a puddle makes you slip and shoot off a good way.
    puddleCount: 3,
    puddleRadius: [0.6, 0.9],
    slipMinSpeed: 1.2, // walking slower than this is safe
    slipSpeed: 8.5, // the slide starts this fast…
    slipGrip: 1.3, // …and slows down this gently (normal grip is 12)
    slipTime: 0.8, // no control while sliding
    slipAgainAfter: 0.5, // seconds back on your feet before you can slip again
    // Rush hour (special event): the aisle fills with standing passengers.
    rushChance: 0.25, // per stop (not the first or the last)
    rushMax: 2, // per game
    rushCount: 22,
    rushLane: 0.55, // they stay in the middle of the aisle, clear of the seats
    rushSqueeze: 0.3, // how much of an overlap is pushed back per tick (1 = solid)
    rushDrag: 0.55, // speed kept while squeezing through
    rushExtraTime: 4, // longer scramble
    // Mini event: the priority seat moves.
    seatMoveChance: 0.3,
    seatMoveAfter: [2, 3.5], // seconds after the doors open
    seatMoveWarn: 1.5, // blinking red before it switches
    seatMoveExtraTime: 3,
    seatMoveGrace: 0.8, // extra time on top of the priority delay before you are asked to stand
    // Kicking a seated passenger: allowed, but the staff notice.
    npcKickRange: 0.6,
    npcKickPenalty: 20,
  },

  points: {
    round: 10, // seated when the doors close
    win: 50,
    kick: 5, // kicked someone off a seat
    allCaught: 50, // everyone taken off by officers: the game starts over and each player loses this
  },

  powerUp: {
    pickRange: 0.6,
    shieldTime: 4,
    boostTime: 5, // iced coffee
    boostSpeed: 1.4, // times normal speed
    sickTime: 5, // MBG tray: green and slow
    sickSpeed: 0.55,
    /** 1 to 3 items lie on the floor at every stop. */
    perStop: [1, 3],
  },

  /**
   * Seats get scarcer toward the end of the line: the first stops have more
   * seats than players (warm-up), then one too few, later two too few, and
   * the last station of the journey has a single seat (the final).
   */
  seats: {
    earlyUntilStop: 2, // stops 1-2: more seats than players
    earlyExtra: 2, // … this many more
    tighterFromStop: 5, // from stop 5: two seats too few
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
