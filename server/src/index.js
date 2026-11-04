require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Go9Game = require('./games/go9');
const app = express(); app.use(cors()); app.use(express.json());
let game = new Go9Game();
app.get('/api/go9/state', (req, res) => res.json(game.getState()));
app.post('/api/go9/move', (req, res) => { const r = game.place(req.body.x, req.body.y); if (!r.ok) return res.status(400).json(r); res.json(game.getState()); });
app.post('/api/go9/pass', (req, res) => { const r = game.pass(); res.json({ ...r, state: game.getState() }); });
app.post('/api/go9/reset', (req, res) => { game = new Go9Game(); res.json(game.getState()); });
const HeuristicGoAgent = require('./agents/heuristicGoAgent');
const hAgent = new HeuristicGoAgent();
app.post('/api/go9/ai-move', async (req,res) => {
  const move = await hAgent.getMove(game.board, game.moves, game.currentPlayer);
  game.place(move.x, move.y);
  res.json({move, state:game.getState()});
});
app.listen(3001, () => console.log('✅ 后端已启动: http://localhost:3001'));
