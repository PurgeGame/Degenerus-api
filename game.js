import crypto from 'node:crypto';

const BUCKET_WEIGHTS = [10, 10, 10, 10, 9, 9, 9, 8];
const TOTAL_WEIGHT = 75;
const FULL_TICKET_PAYOUTS_BPS = [
  0,
  0,
  189,
  500,
  1778,
  6667,
  31100,
  155600,
  355600,
];
const JACKPOT_MULTIPLIER_BPS = 10000000;
const SPECIAL_MATCH_MIN_MULTIPLIER_BPS = 400;
const CURRENCY_WWXRP = 3;
const CURRENCY_NAMES = ['ETH', 'BURNIE', 'DGNRS', 'WWXRP'];

const ROI_THRESHOLDS = {
  MIN_SCORE: 0,
  MID_SCORE: 7500,
  HIGH_SCORE: 25500,
  MAX_SCORE: 35500,
};
const ROI_VALUES = {
  MIN: 9000,
  MID: 9500,
  HIGH: 9950,
  MAX: 9990,
};
const ETH_ROI_BONUS_BPS = 500;
const WWXRP_HIGH_ROI_MIN = 9000;
const WWXRP_HIGH_ROI_MAX = 10990;
const WWXRP_BONUS_FACTOR_SCALE = 1000000;
const WWXRP_BONUS_FACTOR_BUCKET5 = 144136;
const WWXRP_BONUS_FACTOR_BUCKET6 = 900848;
const WWXRP_BONUS_FACTOR_BUCKET7 = 4206141;
const WWXRP_BONUS_FACTOR_BUCKET8 = 97914359;
const WWXRP_BONUS_FACTOR_BUCKET9 = 344701627;
const FULL_TICKET_NON_WWXRP_SCALE = 0.871470;

function randomInt(max) {
  return crypto.randomInt(max);
}

function weightedBucket(randomValue) {
  const value = randomValue % TOTAL_WEIGHT;
  let cumulative = 0;
  for (let i = 0; i < BUCKET_WEIGHTS.length; i += 1) {
    cumulative += BUCKET_WEIGHTS[i];
    if (value < cumulative) return i;
  }
  return 7;
}

function randomWeightedBucket() {
  return weightedBucket(randomInt(TOTAL_WEIGHT));
}

export function generateRandomTicket(forPlayer = true) {
  const traits = [
    { quadrant: 0, color: randomWeightedBucket(), symbol: randomWeightedBucket() },
    { quadrant: 1, color: randomWeightedBucket(), symbol: randomWeightedBucket() },
    { quadrant: 2, color: randomWeightedBucket(), symbol: randomWeightedBucket() },
    { quadrant: 3, color: randomWeightedBucket(), symbol: randomWeightedBucket() },
  ];

  let special = 0;
  if (forPlayer) {
    special = 1 + randomInt(3);
  } else {
    const roll = randomInt(100);
    if (roll === 0) special = 1;
    else if (roll === 1) special = 2;
    else if (roll === 2) special = 3;
    else special = 0;
  }

  return { traits, special };
}

function countMatches(playerTicket, resultTicket) {
  let matches = 0;
  for (let q = 0; q < 4; q += 1) {
    if (playerTicket.traits[q].color === resultTicket.traits[q].color) matches += 1;
    if (playerTicket.traits[q].symbol === resultTicket.traits[q].symbol) matches += 1;
  }
  return matches;
}

function specialsMatch(playerSpecial, resultSpecial) {
  return playerSpecial !== 0 && playerSpecial === resultSpecial;
}

function calculateRoi(activityScore, currency) {
  let roi;
  if (activityScore <= ROI_THRESHOLDS.MIN_SCORE) {
    roi = ROI_VALUES.MIN;
  } else if (activityScore <= ROI_THRESHOLDS.MID_SCORE) {
    const progress = activityScore / ROI_THRESHOLDS.MID_SCORE;
    const quadratic = progress * progress;
    roi = ROI_VALUES.MIN + Math.floor((ROI_VALUES.MID - ROI_VALUES.MIN) * quadratic);
  } else if (activityScore <= ROI_THRESHOLDS.HIGH_SCORE) {
    const progress = (activityScore - ROI_THRESHOLDS.MID_SCORE) / (ROI_THRESHOLDS.HIGH_SCORE - ROI_THRESHOLDS.MID_SCORE);
    roi = ROI_VALUES.MID + Math.floor((ROI_VALUES.HIGH - ROI_VALUES.MID) * progress);
  } else if (activityScore <= ROI_THRESHOLDS.MAX_SCORE) {
    const progress = (activityScore - ROI_THRESHOLDS.HIGH_SCORE) / (ROI_THRESHOLDS.MAX_SCORE - ROI_THRESHOLDS.HIGH_SCORE);
    roi = ROI_VALUES.HIGH + Math.floor((ROI_VALUES.MAX - ROI_VALUES.HIGH) * progress);
  } else {
    roi = ROI_VALUES.MAX;
  }

  return roi;
}

function calculateWwxrpHighRoi(activityScore) {
  if (activityScore <= ROI_THRESHOLDS.MIN_SCORE) return WWXRP_HIGH_ROI_MIN;
  if (activityScore >= ROI_THRESHOLDS.MAX_SCORE) return WWXRP_HIGH_ROI_MAX;
  const progress = activityScore / ROI_THRESHOLDS.MAX_SCORE;
  return WWXRP_HIGH_ROI_MIN + Math.floor((WWXRP_HIGH_ROI_MAX - WWXRP_HIGH_ROI_MIN) * progress);
}

function bonusBucket(matches, specialMatch) {
  if (matches < 5) return 0;
  if (matches === 8) return specialMatch ? 9 : 8;
  return matches;
}

function bonusRoiForBucket(bucket, bonusRoiBps) {
  let factor = 0;
  if (bucket === 5) factor = WWXRP_BONUS_FACTOR_BUCKET5;
  else if (bucket === 6) factor = WWXRP_BONUS_FACTOR_BUCKET6;
  else if (bucket === 7) factor = WWXRP_BONUS_FACTOR_BUCKET7;
  else if (bucket === 8) factor = WWXRP_BONUS_FACTOR_BUCKET8;
  else if (bucket === 9) factor = WWXRP_BONUS_FACTOR_BUCKET9;
  if (!factor) return 0;
  return Math.floor((bonusRoiBps * factor) / WWXRP_BONUS_FACTOR_SCALE);
}

function calculateEvNormalization(playerTicket) {
  let totalWeightProduct = 1;
  const uniformWeightProduct = Math.pow(10 / TOTAL_WEIGHT, 8);

  for (const trait of playerTicket.traits) {
    totalWeightProduct *= BUCKET_WEIGHTS[trait.color] / TOTAL_WEIGHT;
    totalWeightProduct *= BUCKET_WEIGHTS[trait.symbol] / TOTAL_WEIGHT;
  }

  return uniformWeightProduct / totalWeightProduct;
}

function formatCurrencyAmount(amount, currency, noDecimals = false) {
  const name = CURRENCY_NAMES[currency] ?? '';
  const decimals = noDecimals ? 0 : 2;
  return `${amount.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} ${name}`.trim();
}

function formatMultiplier(value, noDecimals = false) {
  if (!Number.isFinite(value)) return 'n/a';
  const decimals = noDecimals ? 0 : 2;
  return `x${value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function formatActivityScore(scoreBps) {
  return `${(scoreBps / 100).toFixed(1)}%`;
}

function buildMathTable(rows, addSeparatorBeforeLast) {
  const valueWidth = rows.reduce((max, [value]) => Math.max(max, value.length), 0);
  const lines = rows.map(([value, label]) => `${value.padEnd(valueWidth, ' ')} | ${label}`);
  if (addSeparatorBeforeLast && lines.length >= 2) {
    const lineLen = lines.reduce((max, line) => Math.max(max, line.length), 0);
    const separator = '-'.repeat(lineLen);
    lines.splice(lines.length - 1, 0, separator);
  }
  return lines.join('\n');
}

export function spinFullTicket({ player, ticket, amount, currency }) {
  const balance = Number(player.balance_wwxrp);
  if (balance < amount) return null;

  const playerSpecial = Number(ticket.special);
  if (playerSpecial < 1 || playerSpecial > 3) return null;

  const activityScore = Math.min(Number(player.activity_score_bps) + 100, ROI_THRESHOLDS.MAX_SCORE);
  const roiBps = calculateRoi(activityScore, currency);
  const highRoi = currency === CURRENCY_WWXRP ? calculateWwxrpHighRoi(activityScore) : 0;

  const playerTicket = {
    traits: ticket.traits.map((trait, idx) => ({
      quadrant: idx,
      color: Number(trait.color),
      symbol: Number(trait.symbol),
    })),
    special: playerSpecial,
  };
  const resultTicket = generateRandomTicket(false);

  const matches = countMatches(playerTicket, resultTicket);
  const hasSpecialMatch = specialsMatch(playerTicket.special, resultTicket.special);

  let payoutMultiplierBps;
  let isJackpot = false;
  if (matches === 8 && hasSpecialMatch) {
    payoutMultiplierBps = JACKPOT_MULTIPLIER_BPS;
    isJackpot = true;
  } else if (hasSpecialMatch) {
    const baseTier = Math.min(matches + 1, 8);
    payoutMultiplierBps = Math.max(
      FULL_TICKET_PAYOUTS_BPS[baseTier],
      SPECIAL_MATCH_MIN_MULTIPLIER_BPS
    );
  } else {
    payoutMultiplierBps = FULL_TICKET_PAYOUTS_BPS[matches];
  }

  let effectiveRoi = roiBps;
  const bucket = bonusBucket(matches, hasSpecialMatch);
  if (currency === CURRENCY_WWXRP && highRoi > roiBps && bucket !== 0) {
    const bonusRoi = highRoi - roiBps;
    effectiveRoi = roiBps + bonusRoiForBucket(bucket, bonusRoi);
  } else if (currency === 0 && bucket !== 0) {
    effectiveRoi = roiBps + bonusRoiForBucket(bucket, ETH_ROI_BONUS_BPS);
  }
  const evNorm = calculateEvNormalization(playerTicket);
  let payout = (amount * payoutMultiplierBps * effectiveRoi) / (100 * 10000) * evNorm;
  if (currency !== CURRENCY_WWXRP) {
    payout *= FULL_TICKET_NON_WWXRP_SCALE;
  }
  const totalBet = amount;
  const totalPayout = payout;
  const netResult = totalPayout - totalBet;

  const matchMultiplier = payoutMultiplierBps / 100;
  const activityMultiplier = effectiveRoi / 10000;
  const isLoss = payout <= 0;
  const matchLabel = hasSpecialMatch
    ? 'Special'
    : `${matches} ${matches === 1 ? 'match' : 'matches'}`;
  const noDecimals = Math.abs(payout) >= 100;
  const factors = [
    [formatCurrencyAmount(amount, currency, noDecimals), 'Bet'],
    [formatMultiplier(matchMultiplier, noDecimals), matchLabel],
  ];
  if (!isLoss) {
    factors.push(
      [formatMultiplier(activityMultiplier, noDecimals), 'Activity score'],
      [formatMultiplier(evNorm, noDecimals), 'Difficulty'],
      [formatCurrencyAmount(payout, currency, noDecimals), 'Payout']
    );
  }
  const math = buildMathTable(factors, !isLoss);

  const spin = {
    mode: 1,
    results: [{
      matches,
      specialMatch: hasSpecialMatch,
      payoutMultiplierBps,
      payout,
      playerTicket,
      resultTicket,
      isJackpot,
      math,
    }],
    totalBet,
    totalPayout,
    netResult,
    consolationPrize: 0,
    hasJackpot: isJackpot,
    lootboxPrize: null,
    currency,
    amountPerTicket: amount,
    ticketCount: 1,
  };

  return {
    player: {
      ...player,
      balance_wwxrp: balance - totalBet + totalPayout,
      activity_score_bps: activityScore,
    },
    spin,
  };
}
