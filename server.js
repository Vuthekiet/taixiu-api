const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

let diceHistory = [];
let predictionHistory = [];
let currentPhase = 0;

/**
 * ENGINE V5 - STATISTICAL PATTERN + MD5 MULTI-SIGNAL LEARNING
 *
 * Root cause fixes từ V4.1:
 * [FIX 1] Count mặt 1/6 của phiên hiện tại → vô nghĩa về xác suất
 *         → Thay bằng Streak Detection (chuỗi liên tiếp có cơ sở thống kê)
 * [FIX 2] avg3 window quá nhỏ, không học được gì
 *         → Window 10 phiên + Regression to Mean
 * [FIX 3] Logic cực trị bị reversed (point hiện tại predict chính nó)
 *         → Fix: điểm thấp phiên QUA → dự Tài phiên TỚI
 * [FIX 4] MD5 forEach loop trống, không học gì từ lịch sử
 *         → 4 signals độc lập: hex sum, bit parity, segment, historical bias
 * [FIX 5] Confidence hardcoded vô nghĩa
 *         → Weighted voting tỉ lệ thuận với tín hiệu đồng thuận
 */
function engineV5(sessions, userMD5 = null) {
    if (sessions.length < 5) {
        return { pred: -1, conf: 0, logic: "Đang nạp dữ liệu..." };
    }

    // Map outcome: 1 = Tài (>10), 0 = Xỉu (≤10)
    const recent = sessions.slice(-20);
    const outcomes = recent.map(s => s.point > 10 ? 1 : 0);
    const lastOutcome = outcomes[outcomes.length - 1];
    const lastPoint = sessions[sessions.length - 1].point;

    // ═══════════════════════════════════════════════════════════
    // SIGNAL 1: STREAK DETECTION
    // Chuỗi ≥3 liên tiếp → xác suất đảo chiều tăng dần
    // ═══════════════════════════════════════════════════════════
    let streakLen = 1;
    for (let i = outcomes.length - 2; i >= 0; i--) {
        if (outcomes[i] === lastOutcome) streakLen++;
        else break;
    }

    let streakPred = -1, streakConf = 0;
    if (streakLen >= 3) {
        streakPred = lastOutcome === 1 ? 0 : 1;
        streakConf = Math.min(55 + streakLen * 5, 82);
        // 3 liên tiếp → 70%, 4 → 75%, 5 → 80%, tối đa 82%
    } else if (streakLen === 1) {
        streakPred = lastOutcome;
        streakConf = 52;
    }

    // ═══════════════════════════════════════════════════════════
    // SIGNAL 2: REGRESSION TO MEAN (Window 10 phiên)
    // Nếu 7+/10 phiên là Tài → lean Xỉu và ngược lại
    // ═══════════════════════════════════════════════════════════
    const window10 = outcomes.slice(-10);
    const taiCount = window10.filter(o => o === 1).length;
    const xiuCount = window10.length - taiCount;

    let regrPred = -1, regrConf = 0;
    if (taiCount >= 7) {
        regrPred = 0; // Lean Xỉu
        regrConf = 60 + (taiCount - 7) * 6; // 7→60%, 8→66%, 9→72%, 10→78%
    } else if (xiuCount >= 7) {
        regrPred = 1; // Lean Tài
        regrConf = 60 + (xiuCount - 7) * 6;
    }

    // ═══════════════════════════════════════════════════════════
    // SIGNAL 3: POINT DEVIATION ANALYSIS
    // Điểm phiên VỪA QUA cách trung bình → hồi quy về mean
    // ═══════════════════════════════════════════════════════════
    const pts = sessions.slice(-15).map(s => s.point);
    const avgPt = pts.reduce((a, b) => a + b, 0) / pts.length;
    const deviation = lastPoint - 10.5; // Trung bình lý thuyết = 10.5

    let ptPred = -1, ptConf = 0;
    if (Math.abs(deviation) >= 4) {
        ptPred = deviation > 0 ? 0 : 1;
        ptConf = Math.min(58 + Math.abs(deviation) * 2, 78);
    }
    // Cực trị thực sự (3-5 hoặc 16-18) → hồi quy mạnh
    if (lastPoint <= 5)  { ptPred = 1; ptConf = 80; }
    if (lastPoint >= 16) { ptPred = 0; ptConf = 80; }

    // ═══════════════════════════════════════════════════════════
    // SIGNAL 4: MD5 MULTI-SIGNAL ANALYSIS
    // 4 tín hiệu độc lập từ MD5 hash, voting để ra kết quả
    // ═══════════════════════════════════════════════════════════
    let md5Pred = -1, md5Conf = 0, md5Logic = "";

    if (userMD5 && userMD5.length >= 32) {
        // 4A: Phân tích 4 segment (mỗi segment 8 ký tự hex)
        const segs = [
            userMD5.slice(0, 8),
            userMD5.slice(8, 16),
            userMD5.slice(16, 24),
            userMD5.slice(24, 32)
        ];
        const segVals = segs.map(s => parseInt(s, 16) % 1000);

        // 4B: Bit parity toàn bộ MD5 (128 bit)
        let bitSum = 0;
        for (let i = 0; i < userMD5.length; i++) {
            const v = parseInt(userMD5[i], 16);
            if (!isNaN(v)) {
                bitSum += (v & 1) + ((v >> 1) & 1) + ((v >> 2) & 1) + ((v >> 3) & 1);
            }
        }

        // 4C: Tỉ lệ ký tự cao (8-f) vs thấp (0-7) trong toàn MD5
        let highCount = 0;
        for (const ch of userMD5) {
            const v = parseInt(ch, 16);
            if (!isNaN(v) && v >= 8) highCount++;
        }
        const highRatio = highCount / userMD5.length;

        // 4D: Historical bias — lean ngược chiều đa số gần nhất
        const recentBias = taiCount > xiuCount ? 0 : 1;
        const biasStrength = Math.abs(taiCount - xiuCount);

        // 4 votes độc lập
        const votes = [
            (segVals[0] + segVals[3]) % 2,              // Segment đầu + cuối
            (segVals[1] + segVals[2]) % 2,              // Segment giữa
            bitSum % 2,                                   // Bit parity
            highRatio >= 0.5 ? 1 : 0                     // High char ratio
        ];

        const taiVotes = votes.filter(v => v === 1).length;
        const xiuVotes = votes.filter(v => v === 0).length;

        if (taiVotes !== xiuVotes) {
            md5Pred = taiVotes > xiuVotes ? 1 : 0;
            md5Conf = 52 + Math.abs(taiVotes - xiuVotes) * 9; // 2v0→70%, 3v1→61%, 4v0→88%
            md5Logic = `MD5 ${taiVotes}v${xiuVotes}`;
        } else {
            // Hòa → dùng historical bias làm tiebreak
            md5Pred = recentBias;
            md5Conf = 50 + biasStrength * 2;
            md5Logic = `MD5 tie→bias(${biasStrength})`;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // WEIGHTED VOTING - Tổng hợp tất cả signals
    // ═══════════════════════════════════════════════════════════
    const signals = [];
    if (streakPred !== -1) signals.push({ pred: streakPred, conf: streakConf, name: `Streak(${streakLen})` });
    if (regrPred !== -1)   signals.push({ pred: regrPred,   conf: regrConf,   name: `Regr(${taiCount}T${xiuCount}X)` });
    if (ptPred !== -1)     signals.push({ pred: ptPred,     conf: ptConf,     name: `Point(${lastPoint})` });
    if (md5Pred !== -1)    signals.push({ pred: md5Pred,    conf: md5Conf,    name: md5Logic });

    if (signals.length === 0) {
        return { pred: lastOutcome, conf: 50, logic: "Không đủ tín hiệu → xu hướng gần nhất" };
    }

    // Weighted score
    let scoreTai = 0, scoreXiu = 0;
    for (const s of signals) {
        if (s.pred === 1) scoreTai += s.conf;
        else scoreXiu += s.conf;
    }

    const finalPred = scoreTai >= scoreXiu ? 1 : 0;
    const totalScore = scoreTai + scoreXiu;
    const winScore = Math.max(scoreTai, scoreXiu);
    const finalConf = Math.min(Math.round((winScore / totalScore) * 100), 95);

    const allAgree = signals.every(s => s.pred === finalPred);
    const signalNames = signals.map(s => s.name).join(" | ");
    const logic = allAgree
        ? `✓ ĐỒNG THUẬN: ${signalNames}`
        : `⚡ MAJORITY (${Math.round(winScore)}v${Math.round(totalScore - winScore)}): ${signalNames}`;

    return { pred: finalPred, conf: finalConf, logic };
}

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────

app.post('/api/predict-md5', (req, res) => {
    const { md5 } = req.body;
    if (!md5 || md5.length < 32) {
        return res.status(400).json({ error: "MD5 không hợp lệ (cần ≥32 ký tự)" });
    }
    const analysis = engineV5(diceHistory, md5);
    res.json({
        phien: currentPhase + 1,
        side: analysis.pred === 1 ? 'Tài' : (analysis.pred === 0 ? 'Xỉu' : 'N/A'),
        conf: analysis.conf,
        logic: analysis.logic
    });
});

app.get('/api/data', async (req, res) => {
    try {
        const response = await axios.get(
            'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2',
            { timeout: 4000 }
        );
        const list = response.data.list;
        const latest = list[0];
        diceHistory = [...list].reverse();

        if (currentPhase !== latest.id) {
            currentPhase = latest.id;

            // Cập nhật kết quả thực tế cho dự đoán phiên vừa xong
            if (predictionHistory.length > 0 && predictionHistory[0].phien === latest.id) {
                const last = predictionHistory[0];
                last.real = latest.resultTruyenThong === 'TAI' ? 'Tài' : 'Xỉu';
                last.win = (last.side === last.real);
            }

            // Dự đoán phiên tiếp theo
            const analysis = engineV5(diceHistory);
            predictionHistory.unshift({
                phien: latest.id + 1,
                side: analysis.pred === 1 ? 'Tài' : (analysis.pred === 0 ? 'Xỉu' : 'N/A'),
                real: null,
                win: null,
                conf: analysis.conf,
                logic: analysis.logic
            });

            if (predictionHistory.length > 20) predictionHistory.pop();
        }

        const wins   = predictionHistory.filter(h => h.win === true).length;
        const played = predictionHistory.filter(h => h.win !== null).length;

        res.json({
            current: {
                id: latest.id,
                dices: latest.dices,
                point: latest.point,
                side: latest.resultTruyenThong === 'TAI' ? 'Tài' : 'Xỉu'
            },
            next: predictionHistory[0],
            stats: {
                winRate: played > 0 ? Math.round((wins / played) * 100) : 0,
                played
            },
            history: predictionHistory.slice(1, 11)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Engine V5 Online — port ${PORT}`);
    console.log('Signals: Streak | Regression | PointDeviation | MD5 Multi-Vote');
});
