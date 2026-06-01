const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

// Render automatically assigns process.env.PORT, fallback to 10000
const PORT = process.env.PORT || 10000;

const FIREBASE_DB_URL = "https://abhialgo-cc339-default-rtdb.firebaseio.com/";

// Self-Ping Global Link Configured Automatically
const RENDER_LIVE_URL = "https://abhi-algo-v98-engine.onrender.com";

let activeTrade = null;

function calculateSR(closes, highs, lows) {
    let maxPrice = Math.max(...highs.slice(-20));
    let minPrice = Math.min(...lows.slice(-20));
    return { resistance: maxPrice, support: minPrice };
}

function analyzeCandlePatterns(open, high, low, close) {
    let body = Math.abs(close - open);
    let totalLength = high - low;
    let upperShadow = high - Math.max(open, close);
    let lowerShadow = Math.min(open, close) - low;
    let isBullish = close > open;

    if (totalLength === 0) return { pattern: "STANDARD CANDLE", bias: "NEUTRAL" };

    if (lowerShadow > (body * 2) && upperShadow < (body * 0.5)) return { pattern: "HAMMER (BUY PRESSURE) 🔨", bias: "CALL" };
    if (upperShadow > (body * 2) && lowerShadow < (body * 0.5)) return { pattern: "SHOOTING STAR (SELL PRESSURE) ☄️", bias: "PUT" };
    if (body > (totalLength * 0.85)) return { pattern: isBullish ? "BULLISH MARUBOZU 🟩" : "BEARISH MARUBOZU 🟥", bias: isBullish ? "CALL" : "PUT" };
    
    return { pattern: "STANDARD CANDLE", bias: "NEUTRAL" };
}

async function startMasterAnalysis() {
    try {
        console.log("🤖 Scanning Live Market Matrix...");
        const forexUrl = `https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?region=US&lang=en-US&includePrePost=false&interval=1m&useYfid=true&range=1d`;
        
        const response = await axios.get(forexUrl, { timeout: 9000 });
        
        if (!response.data || !response.data.chart || !response.data.chart.result) {
            throw new Error("MARKET_OFFLINE");
        }

        const result = response.data.chart.result[0];
        const quotes = result.indicators.quote[0];
        
        const opens = quotes.open.filter(x => x !== null);
        const highs = quotes.high.filter(x => x !== null);
        const lows = quotes.low.filter(x => x !== null);
        const closes = quotes.close.filter(x => x !== null);

        // Sat-Sun exact shutdown control check
        if (closes.length < 20) {
            throw new Error("MARKET_OFFLINE");
        }

        const lastPrice = closes[closes.length - 1];
        const prevPrice = closes[closes.length - 2];
        const lastOpen = opens[opens.length - 1];
        const lastHigh = highs[highs.length - 1];
        const lastLow = lows[lows.length - 1];

        // 🎯 Accurate History Result Processing
        if (activeTrade) {
            let prevOpen = opens[opens.length - 2];
            let prevClose = closes[closes.length - 2];
            let isPrevGreen = prevClose > prevOpen;
            
            let tradeResult = "LOSS";
            if (activeTrade.type === "CALL" && isPrevGreen) tradeResult = "WIN";
            if (activeTrade.type === "PUT" && !isPrevGreen) tradeResult = "WIN";

            let timeString = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

            const historyNode = {
                time: timeString,
                asset: "EUR/USD",
                type: activeTrade.type,
                result: tradeResult
            };

            try {
                const fbHist = await axios.get(`${FIREBASE_DB_URL}/tradeHistory.json`, { timeout: 4000 });
                let historyList = fbHist.data || [];
                if (!Array.isArray(historyList)) historyList = [];
                
                historyList.unshift(historyNode);
                if (historyList.length > 10) historyList.pop();

                await axios.put(`${FIREBASE_DB_URL}/tradeHistory.json`, historyList, { timeout: 4000 });
            } catch (err) { console.error("History Save Alert"); }

            activeTrade = null; 
        }

        const sma10 = closes.slice(-10).reduce((a, b) => a + b, 0) / 10;
        let trendM1 = lastPrice > sma10 ? "Bullish" : "Bearish";
        let trendM5 = lastPrice > closes[closes.length - 5] ? "Bullish" : "Bearish";

        let gains = 0, losses = 0;
        for (let i = closes.length - 14; i < closes.length; i++) {
            let diff = closes[i] - closes[i - 1];
            if (diff > 0) gains += diff; else losses -= diff;
        }
        let rsi = losses === 0 ? 100 : 100 - (100 / (1 + (gains / losses)));

        const sr = calculateSR(closes, highs, lows);
        let breakoutStatus = "NO BREAKOUT";
        if (lastPrice > sr.resistance && prevPrice <= sr.resistance) breakoutStatus = "BULLISH BREAKOUT 📈";
        if (lastPrice < sr.support && prevPrice >= sr.support) breakoutStatus = "BEARISH BREAKOUT 📉";

        const candleAnalysis = analyzeCandlePatterns(lastOpen, lastHigh, lastLow, lastPrice);
        
        let callScore = 0;
        let putScore = 0;

        if (trendM1 === "Bullish") callScore += 25; else putScore += 25;
        if (rsi > 52 && rsi < 68) callScore += 25; else if (rsi < 48 && rsi > 32) putScore += 25;
        if (breakoutStatus === "BULLISH BREAKOUT 📈") callScore += 25;
        if (breakoutStatus === "BEARISH BREAKOUT 📉") putScore += 25;
        if (candleAnalysis.bias === "CALL") callScore += 25; else if (candleAnalysis.bias === "PUT") putScore += 25;

        let callBarGlobal = callScore > 0 ? callScore : 50;
        let putBarGlobal = putScore > 0 ? putScore : 50;

        let newSignal = "AVOID";
        if (callScore >= 75) {
            newSignal = "CALL";
            activeTrade = { type: "CALL" };
        } else if (putScore >= 75) {
            newSignal = "PUT";
            activeTrade = { type: "PUT" };
        }

        await axios.put(`${FIREBASE_DB_URL}/liveData.json`, {
            status: "OPEN",
            signal: newSignal,
            callBar: callBarGlobal,
            putBar: putBarGlobal,
            lastPrice: lastPrice.toFixed(5),
            pattern: candleAnalysis.pattern,
            trendM1: trendM1,
            trendM5: trendM5,
            timestamp: Date.now()
        }, { timeout: 4000 });

    } catch (error) {
        // Safe lock weekend mode
        activeTrade = null;
        try {
            await axios.put(`${FIREBASE_DB_URL}/liveData.json`, {
                status: "CLOSED",
                signal: "MARKET CLOSED",
                callBar: 50,
                putBar: 50,
                lastPrice: "CLOSED",
                pattern: "MARKET SLEEPING",
                trendM1: "OFFLINE",
                trendM5: "OFFLINE",
                timestamp: Date.now()
            }, { timeout: 4000 });
        } catch (e) {}
    }
}

// ⏰ Final Non-Sleep Loop (Pings every 4 minutes to remain up permanently)
setInterval(async () => {
    try {
        await axios.get(RENDER_LIVE_URL, { timeout: 4000 });
        console.log("⏰ Keep-Alive Engine Pulse Sent.");
    } catch (e) {}
}, 240000); 

setInterval(startMasterAnalysis, 60000);

app.get('/', (req, res) => { res.json({ status: "AbhiAlgo V9.8 Final Master Engine Standby" }); });

app.listen(PORT, () => {
    console.log(`Final Engine Binded on Port ${PORT}`);
    startMasterAnalysis();
});
        const closes = quotes.close.filter(x => x !== null);

        // Weekend standard freeze detection
        if (closes.length < 20) {
            throw new Error("MARKET_OFFLINE");
        }

        const lastPrice = closes[closes.length - 1];
        const prevPrice = closes[closes.length - 2];
        const lastOpen = opens[opens.length - 1];
        const lastHigh = highs[highs.length - 1];
        const lastLow = lows[lows.length - 1];

        // Anti-Fake Real History Sync Engine
        if (activeTrade) {
            let prevOpen = opens[opens.length - 2];
            let prevClose = closes[closes.length - 2];
            let isPrevGreen = prevClose > prevOpen;
            
            let tradeResult = "LOSS";
            if (activeTrade.type === "CALL" && isPrevGreen) tradeResult = "WIN";
            if (activeTrade.type === "PUT" && !isPrevGreen) tradeResult = "WIN";

            let timeString = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

            const historyNode = {
                time: timeString,
                asset: "EUR/USD",
                type: activeTrade.type,
                result: tradeResult
            };

            try {
                const fbHist = await axios.get(`${FIREBASE_DB_URL}/tradeHistory.json`);
                let historyList = fbHist.data || [];
                if (!Array.isArray(historyList)) historyList = [];
                
                historyList.unshift(historyNode);
                if (historyList.length > 10) historyList.pop();

                await axios.put(`${FIREBASE_DB_URL}/tradeHistory.json`, historyList);
            } catch (err) { console.error("History Sync Error"); }

            activeTrade = null; 
        }

        // Indicators Analysis
        const sma10 = closes.slice(-10).reduce((a, b) => a + b, 0) / 10;
        let trendM1 = lastPrice > sma10 ? "Bullish" : "Bearish";
        let trendM5 = lastPrice > closes[closes.length - 5] ? "Bullish" : "Bearish";

        let gains = 0, losses = 0;
        for (let i = closes.length - 14; i < closes.length; i++) {
            let diff = closes[i] - closes[i - 1];
            if (diff > 0) gains += diff; else losses -= diff;
        }
        let rsi = losses === 0 ? 100 : 100 - (100 / (1 + (gains / losses)));

        const sr = calculateSR(closes, highs, lows);
        let breakoutStatus = "NO BREAKOUT";
        if (lastPrice > sr.resistance && prevPrice <= sr.resistance) breakoutStatus = "BULLISH BREAKOUT 📈";
        if (lastPrice < sr.support && prevPrice >= sr.support) breakoutStatus = "BEARISH BREAKOUT 📉";

        const candleAnalysis = analyzeCandlePatterns(lastOpen, lastHigh, lastLow, lastPrice);
        
        let callScore = 0;
        let putScore = 0;

        if (trendM1 === "Bullish") callScore += 25; else putScore += 25;
        if (rsi > 52 && rsi < 68) callScore += 25; else if (rsi < 48 && rsi > 32) putScore += 25;
        if (breakoutStatus === "BULLISH BREAKOUT 📈") callScore += 25;
        if (breakoutStatus === "BEARISH BREAKOUT 📉") putScore += 25;
        if (candleAnalysis.bias === "CALL") callScore += 25; else if (candleAnalysis.bias === "PUT") putScore += 25;

        let callBarGlobal = callScore > 0 ? callScore : 50;
        let putBarGlobal = putScore > 0 ? putScore : 50;

        let newSignal = "AVOID";
        if (callScore >= 75) {
            newSignal = "CALL";
            activeTrade = { type: "CALL" };
        } else if (putScore >= 75) {
            newSignal = "PUT";
            activeTrade = { type: "PUT" };
        }

        await axios.put(`${FIREBASE_DB_URL}/liveData.json`, {
            status: "OPEN",
            signal: newSignal,
            callBar: callBarGlobal,
            putBar: putBarGlobal,
            lastPrice: lastPrice.toFixed(5),
            pattern: candleAnalysis.pattern,
            trendM1: trendM1,
            trendM5: trendM5,
            timestamp: Date.now()
        });

    } catch (error) {
        // Automatic Refresh/Reset Condition for Weekends
        activeTrade = null;
        await axios.put(`${FIREBASE_DB_URL}/liveData.json`, {
            status: "CLOSED",
            signal: "MARKET CLOSED",
            callBar: 50,
            putBar: 50,
            lastPrice: "CLOSED",
            pattern: "MARKET SLEEPING",
            trendM1: "OFFLINE",
            trendM5: "OFFLINE",
            timestamp: Date.now()
        });
    }
}

// 1-Minute Core Sync Trigger Interval
setInterval(startMasterAnalysis, 60000);

app.get('/', (req, res) => { res.json({ status: "AbhiAlgo Core V9.8 Active" }); });

app.listen(PORT, () => {
    console.log(`Server launched on port ${PORT}`);
    startMasterAnalysis();
});
      
