require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('../generated/prisma/client');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const Go9Game = require('./games/go9');
const HeuristicGoAgent = require('./agents/heuristicGoAgent');

const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: 'file:./prisma/dev.db' }) });
const hAgent = new HeuristicGoAgent();
const app = express(); app.use(cors()); app.use(express.json());

let game = new Go9Game(); let currentGameId = null;

async function saveGame() {
  if (!currentGameId) { const r = await prisma.game.create({ data: { gameType:'go9', boardState:JSON.stringify(game.board), moveHistory:JSON.stringify([]) } }); currentGameId = r.id; }
  await prisma.game.update({ where:{id:currentGameId}, data:{ boardState:JSON.stringify(game.board), moveHistory:JSON.stringify(game.moves), status:game.winner?'finished':'playing', winner:game.winner||null } });
}

app.get('/api/go9/state', (req,res) => res.json(game.getState()));
app.post('/api/go9/move', async (req,res) => { const r = game.place(req.body.x, req.body.y); if(!r.ok) return res.status(400).json(r); await saveGame(); res.json(game.getState()); });
app.post('/api/go9/pass', async (req,res) => { const r = game.pass(); await saveGame(); res.json({...r, state:game.getState()}); });
app.post('/api/go9/reset', (req,res) => { game = new Go9Game(); currentGameId = null; res.json(game.getState()); });
app.post('/api/go9/ai-move', async (req,res) => { const m = await hAgent.getMove(game.board, game.moves, game.currentPlayer); if(m){ game.place(m.x,m.y); await saveGame(); } res.json({move:m, state:game.getState()}); });

app.listen(3001, () => console.log('✅ 后端启动: http://localhost:3001'));
