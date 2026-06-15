/**
 * ETH Multi-Timeframe MACD Cross Monitor (Standalone Cloud Edition)
 * 
 * Pure Node.js, zero dependencies, Linux/macOS/Windows compatible.
 * Sends Feishu notifications via custom bot Webhook.
 * Designed for GitHub Actions / cron / cloud functions.
 * 
 * Data source: https://data-api.binance.vision (Binance public data API)
 * MACD: EMA(12), EMA(26), Signal EMA(9)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// --- Config ---
const SCRIPT_DIR = __dirname;
const STATE_FILE = path.join(SCRIPT_DIR, 'eth_macd_state.json');
const BASE_URL = 'https://data-api.binance.vision/api/v3/klines';
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown

const WEBHOOK_URL = process.env.FEISHU_WEBHOOK_URL || '';

const TIMEFRAMES = [
  { name: '15M', binance: '15m', candles: 150 },
  { name: '1H',  binance: '1h',  candles: 150 },
  { name: '4H',  binance: '4h',  candles: 150 },
];

// --- MACD Calculation ---
function ema(data, period) {
  const k = 2 / (period + 1);
  const result = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function calcMACD(closes) {
  if (closes.length < 35) return null;
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const dif = ema12.map((v, i) => v - ema26[i]);
  const dea = ema(dif, 9);
  const histogram = dif.map((v, i) => 2 * (v - dea[i]));
  return { dif, dea, histogram };
}

function detectCross(macd) {
  if (!macd) return null;
  const len = macd.dif.length;
  const prevDif = macd.dif[len - 2];
  const prevDea = macd.dea[len - 2];
  const currDif = macd.dif[len - 1];
  const currDea = macd.dea[len - 1];
  
  if (prevDif <= prevDea && currDif > currDea) return 'golden';
  if (prevDif >= prevDea && currDif < currDea) return 'death';
  return null;
}

// --- Data Fetching ---
function fetchBinanceKlines(interval, limit) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}?symbol=ETHUSDT&interval=${interval}&limit=${limit}`;
    const req = https.get(url, { timeout: 20000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!Array.isArray(parsed)) {
            reject(new Error(`Unexpected response: ${data.substring(0, 200)}`));
            return;
          }
          const klines = parsed.map(k => ({
            time: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
          }));
          resolve(klines);
        } catch (e) {
          reject(new Error(`Parse error: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

// --- Feishu Webhook Notification ---
function sendFeishuWebhook(title, content) {
  return new Promise((resolve, reject) => {
    if (!WEBHOOK_URL) {
      console.log('No webhook URL configured, skipping notification');
      return resolve(false);
    }
    
    const url = new URL(WEBHOOK_URL);
    const payload = JSON.stringify({
      msg_type: 'interactive',
      card: {
        header: {
          title: { tag: 'plain_text', content: title },
          template: title.includes('金叉') ? 'green' : title.includes('死叉') ? 'red' : 'blue',
        },
        elements: [
          {
            tag: 'markdown',
            content: content,
          },
          {
            tag: 'note',
            elements: [
              { tag: 'plain_text', content: '⚠️ 技术指标信号，不构成投资建议' },
            ],
          },
        ],
      },
    });
    
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.code === 0 || result.StatusCode === 0) {
            console.log('✅ Webhook notification sent');
            resolve(true);
          } else {
            console.error('Webhook error:', data);
            resolve(false);
          }
        } catch (e) {
          console.error('Parse error:', data.substring(0, 200));
          resolve(false);
        }
      });
    });
    
    req.on('error', (e) => { console.error('Webhook request failed:', e.message); resolve(false); });
    req.on('timeout', () => { req.destroy(); console.error('Webhook timeout'); resolve(false); });
    req.write(payload);
    req.end();
  });
}

// --- State Management ---
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch (e) { console.error('State load error:', e.message); }
  return { lastNotification: null, lastCrosses: {} };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) { console.error('State save error:', e.message); }
}

// --- Main ---
async function main() {
  console.log(`\n=== ETH MACD Cross Monitor ===`);
  console.log(`Time: ${new Date().toISOString()} (CST: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})`);
  console.log(`Webhook: ${WEBHOOK_URL ? 'configured' : 'NOT configured'}`);
  
  const state = loadState();
  const crosses = {};
  const details = {};
  
  for (const tf of TIMEFRAMES) {
    try {
      console.log(`Fetching ${tf.name}...`);
      const klines = await fetchBinanceKlines(tf.binance, tf.candles);
      console.log(`  ${tf.name}: ${klines.length} candles`);
      
      const closes = klines.map(k => k.close);
      const macd = calcMACD(closes);
      
      if (!macd) {
        console.log(`  ⚠ Not enough data for ${tf.name}`);
        crosses[tf.name] = null;
        continue;
      }
      
      const cross = detectCross(macd);
      const lastClose = closes[closes.length - 1];
      const lastDif = macd.dif[macd.dif.length - 1];
      const lastDea = macd.dea[macd.dea.length - 1];
      
      crosses[tf.name] = cross;
      details[tf.name] = {
        cross: cross || 'none',
        close: lastClose.toFixed(2),
        dif: lastDif.toFixed(4),
        dea: lastDea.toFixed(4),
      };
      
      console.log(`  ${tf.name}: price=${lastClose.toFixed(2)}, DIF=${lastDif.toFixed(4)}, DEA=${lastDea.toFixed(4)}, cross=${cross || 'none'}`);
    } catch (e) {
      console.error(`  ✗ ${tf.name}: ${e.message}`);
      crosses[tf.name] = null;
    }
  }
  
  // Check simultaneous cross
  const validCrosses = Object.entries(crosses).filter(([_, v]) => v !== null);
  const crossValues = validCrosses.map(([_, v]) => v);
  const allGolden = crossValues.length === 3 && crossValues.every(v => v === 'golden');
  const allDeath = crossValues.length === 3 && crossValues.every(v => v === 'death');
  
  const now = Date.now();
  
  if (allGolden || allDeath) {
    const signalType = allGolden ? 'golden' : 'death';
    const lastNotif = state.lastNotification;
    const canNotify = !lastNotif || 
                      lastNotif.type !== signalType || 
                      (now - lastNotif.time) > COOLDOWN_MS;
    
    if (canNotify) {
      const emoji = allGolden ? '🟢' : '🔴';
      const crossName = allGolden ? '金叉' : '死叉';
      const direction = allGolden ? '看多信号' : '看空信号';
      const title = `${emoji} ETH/USDT 多周期${crossName}`;
      
      const content = [
        `**${direction}**：4H / 1H / 15M 同时${crossName}`,
        '',
        `**4H**　价格 ${details['4H']?.close || '-'}　DIF ${details['4H']?.dif || '-'}　DEA ${details['4H']?.dea || '-'}`,
        `**1H**　价格 ${details['1H']?.close || '-'}　DIF ${details['1H']?.dif || '-'}　DEA ${details['1H']?.dea || '-'}`,
        `**15M**　价格 ${details['15M']?.close || '-'}　DIF ${details['15M']?.dif || '-'}　DEA ${details['15M']?.dea || '-'}`,
        '',
        `检测时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      ].join('\n');
      
      console.log('\n🔔 SIGNAL DETECTED!');
      console.log(title);
      console.log(content);
      
      const sent = await sendFeishuWebhook(title, content);
      if (sent) {
        state.lastNotification = { type: signalType, time: now };
      }
    } else {
      console.log(`\n  ℹ ${allGolden ? '金叉' : '死叉'}信号重复，冷却中`);
    }
  } else {
    console.log('\n  ℹ 无多周期同步信号');
    Object.entries(crosses).forEach(([tf, cross]) => {
      console.log(`  ${tf}: ${cross || '无信号'} ${details[tf] ? `(DIF=${details[tf].dif} DEA=${details[tf].dea})` : ''}`);
    });
    // Send heartbeat notification (once per hour max)
    const lastHeartbeat = state.lastHeartbeat || 0;
    if (WEBHOOK_URL && (now - lastHeartbeat) > COOLDOWN_MS) {
      const statusLines = Object.entries(details).map(([tf, d]) => {
        const trend = parseFloat(d.dif) > parseFloat(d.dea) ? '🟢偏多' : '🔴偏空';
        return `**${tf}**　价格 ${d.close}　DIF ${d.dif}　DEA ${d.dea}　${trend}`;
      });
      const content = [
        '**当前无多周期同步信号**',
        '',
        ...statusLines,
        '',
        `检测时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      ].join('\n');
      const sent = await sendFeishuWebhook('📡 ETH MACD状态速览', content);
      if (sent) state.lastHeartbeat = now;
    }
  }
  
  state.lastCrosses = crosses;
  state.lastCheck = now;
  saveState(state);
  console.log('\n=== Done ===');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
