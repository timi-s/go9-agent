const Go9Game = require('../games/go9');
class HeuristicGoAgent {
  async getMove(boardState, moveHistory, player) {
    const game = new Go9Game(); game.board = boardState.map(r=>r.slice()); game.currentPlayer = player;
    const candidates = [];
    for (let y=0;y<9;y++) for (let x=0;x<9;x++) if (game.board[y][x]===null) candidates.push({x,y});
    const scored = candidates.map(({x,y}) => {
      let score = 0; const copy = game.board.map(r=>r.slice()); copy[y][x]=player;
      const opponent = player==='black'?'white':'black';
      let captured = 0;
      for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx=x+dx, ny=y+dy; if (nx<0||nx>=9||ny<0||ny>=9) continue;
        if (copy[ny][nx]===opponent) { const {group,liberties}=game.getGroupAndLiberties(copy,nx,ny); if (liberties.size===0) captured+=group.length; }
      }
      score += captured*100;
      for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx=x+dx, ny=y+dy; if (nx<0||nx>=9||ny<0||ny>=9) continue;
        if (copy[ny][nx]===player) { const {liberties}=game.getGroupAndLiberties(copy,nx,ny); if (liberties.size===1) score+=80; }
      }
      let minDist=999;
      for (let yy=0;yy<9;yy++) for (let xx=0;xx<9;xx++) if (game.board[yy][xx]) { const d=Math.abs(xx-x)+Math.abs(yy-y); if(d<minDist)minDist=d; }
      if (minDist<999) score += Math.max(0, 20-minDist*5); else score += 5;
      score += (4-Math.abs(x-4))+(4-Math.abs(y-4));
      return {x,y,score};
    });
    scored.sort((a,b)=>b.score-a.score);
    return scored[0] || null;
  }
}
module.exports = HeuristicGoAgent;
