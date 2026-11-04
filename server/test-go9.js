const Go9Game = require('./src/games/go9');
function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('PASS:', msg); }
const g1 = new Go9Game(); g1.place(0,0); g1.place(1,0); g1.place(8,8); g1.place(0,1); g1.place(7,7);
assert(g1.board[0][0] === null, '单子被提掉');
const g2 = new Go9Game(); g2.board[0][1]='black'; g2.board[1][0]='black'; g2.board[1][1]='black'; g2.currentPlayer='white';
assert(g2.place(0,0).reason === 'suicide', '自杀手被拒绝');
const g3 = new Go9Game(); g3.koPoint = {x:2,y:2}; assert(g3.place(2,2).reason === 'ko', '打劫禁入');
const g4 = new Go9Game(); g4.pass(); assert(g4.pass().gameOver === true, '两次PASS结束');
console.log('\n✅ 全部测试通过');
