import crypto from 'node:crypto';

const BUCKET_WEIGHTS = [10, 10, 10, 10, 9, 9, 9, 8];
const TOTAL_WEIGHT = 75;
const FULL_TICKET_PAYOUTS_BPS = [
  0,
  0,
  190,
  475,
  1500,
  4250,
  19500,
  100000,
  10000000,
];
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
const WWXRP_BONUS_FACTOR_BUCKET5 = 1531388;
const WWXRP_BONUS_FACTOR_BUCKET6 = 13016797;
const WWXRP_BONUS_FACTOR_BUCKET7 = 57745766;
const WWXRP_BONUS_FACTOR_BUCKET8 = 30027799;

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

export function generateRandomTicket() {
  const traits = [
    { quadrant: 0, color: randomWeightedBucket(), symbol: randomWeightedBucket() },
    { quadrant: 1, color: randomWeightedBucket(), symbol: randomWeightedBucket() },
    { quadrant: 2, color: randomWeightedBucket(), symbol: randomWeightedBucket() },
    { quadrant: 3, color: randomWeightedBucket(), symbol: randomWeightedBucket() },
  ];

  return { traits };
}

function countMatches(playerTicket, resultTicket) {
  let matches = 0;
  for (let q = 0; q < 4; q += 1) {
    if (playerTicket.traits[q].color === resultTicket.traits[q].color) matches += 1;
    if (playerTicket.traits[q].symbol === resultTicket.traits[q].symbol) matches += 1;
  }
  return matches;
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

function bonusBucket(matches) {
  if (matches < 5) return 0;
  return matches; // 5,6,7,8
}

function bonusRoiForBucket(bucket, bonusRoiBps) {
  let factor = 0;
  if (bucket === 5) factor = WWXRP_BONUS_FACTOR_BUCKET5;
  else if (bucket === 6) factor = WWXRP_BONUS_FACTOR_BUCKET6;
  else if (bucket === 7) factor = WWXRP_BONUS_FACTOR_BUCKET7;
  else if (bucket === 8) factor = WWXRP_BONUS_FACTOR_BUCKET8;
  if (!factor) return 0;
  return Math.floor((bonusRoiBps * factor) / WWXRP_BONUS_FACTOR_SCALE);
}

// Per-outcome EV normalization using product-of-ratios
function calculateEvNormalization(playerTicket, resultTicket) {
  let num = 1;
  let den = 1;

  for (let q = 0; q < 4; q += 1) {
    const pColor = playerTicket.traits[q].color;
    const pSymbol = playerTicket.traits[q].symbol;
    const rColor = resultTicket.traits[q].color;
    const rSymbol = resultTicket.traits[q].symbol;

    const wC = BUCKET_WEIGHTS[pColor];
    const wS = BUCKET_WEIGHTS[pSymbol];

    const colorMatch = pColor === rColor;
    const symbolMatch = pSymbol === rSymbol;

    if (colorMatch && symbolMatch) {
      num *= 100;
      den *= wC * wS;
    } else if (colorMatch || symbolMatch) {
      num *= 1300;
      den *= 75 * (wC + wS) - 2 * wC * wS;
    } else {
      num *= 4225;
      den *= (TOTAL_WEIGHT - wC) * (TOTAL_WEIGHT - wS);
    }
  }

  return num / den;
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

  const activityScore = Math.min(Number(player.activity_score_bps) + 100, ROI_THRESHOLDS.MAX_SCORE);
  const roiBps = calculateRoi(activityScore, currency);
  const highRoi = currency === CURRENCY_WWXRP ? calculateWwxrpHighRoi(activityScore) : 0;

  const playerTicket = {
    traits: ticket.traits.map((trait, idx) => ({
      quadrant: idx,
      color: Number(trait.color),
      symbol: Number(trait.symbol),
    })),
  };
  const resultTicket = generateRandomTicket();

  const matches = countMatches(playerTicket, resultTicket);

  const payoutMultiplierBps = FULL_TICKET_PAYOUTS_BPS[matches];
  const isJackpot = matches === 8;

  let effectiveRoi = roiBps;
  const bucket = bonusBucket(matches);
  if (currency === CURRENCY_WWXRP && highRoi > roiBps && bucket !== 0) {
    const bonusRoi = highRoi - roiBps;
    effectiveRoi = roiBps + bonusRoiForBucket(bucket, bonusRoi);
  } else if (currency === 0 && bucket !== 0) {
    effectiveRoi = roiBps + bonusRoiForBucket(bucket, ETH_ROI_BONUS_BPS);
  }

  const evNorm = calculateEvNormalization(playerTicket, resultTicket);
  let payout = (amount * payoutMultiplierBps * effectiveRoi) / 1_000_000 * evNorm;

  const totalBet = amount;
  const totalPayout = payout;
  const netResult = totalPayout - totalBet;

  const matchMultiplier = payoutMultiplierBps / 100;
  const activityMultiplier = effectiveRoi / 10000;
  const isLoss = payout <= 0;
  const matchLabel = `${matches} ${matches === 1 ? 'match' : 'matches'}`;
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
