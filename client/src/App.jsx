import { useState, useEffect } from 'react';
const SIZE = 9, CELL = 40, OFFSET = 20;
export default function App() {
  const [state, setState] = useState(null);
  const API = 'http://localhost:3001/api/go9';
  useEffect(() => { fetch(`${API}/state`).then(r=>r.json()).then(setState); }, []);
  const play = async (x, y) => { if (!state || state.winner || state.board[y][x]) return; const r = await fetch(`${API}/move`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({x,y})}); if (r.ok) setState(await r.json()); };
  const pass = async () => { const r = await fetch(`${API}/pass`,{method:'POST'}); const d = await r.json(); setState(d.state); if(d.gameOver) alert(`游戏结束，${d.winner}胜`); };
  const reset = async () => { setState(await (await fetch(`${API}/reset`,{method:'POST'})).json()); };
  if (!state) return <div>加载中...</div>;
  const boardSize = OFFSET * 2 + CELL * (SIZE - 1);
  return (
    <div style={{padding:20}}>
      <h2>九路围棋</h2>
      <div>执子：{state.currentPlayer==='black'?'黑':'白'} | 提子：黑 {state.captures.black} 白 {state.captures.white}</div>
      <div style={{position:'relative',width:boardSize,height:boardSize,background:'#DCB35C',marginTop:12}}>
        {Array(SIZE).fill().map((_,i)=>(<div key={`h${i}`} style={{position:'absolute',left:OFFSET,top:OFFSET+i*CELL,width:CELL*(SIZE-1),height:1,background:'#333'}}/>))}
        {Array(SIZE).fill().map((_,i)=>(<div key={`v${i}`} style={{position:'absolute',left:OFFSET+i*CELL,top:OFFSET,width:1,height:CELL*(SIZE-1),background:'#333'}}/>))}
        {state.board.map((row,y)=>row.map((cell,x)=>!cell?null:(
          <div key={`${x},${y}`} style={{position:'absolute',left:OFFSET+x*CELL-16,top:OFFSET+y*CELL-16,width:32,height:32,borderRadius:'50%',background:cell==='black'?'#111':'#fff',border:'1px solid #666'}}/>
        )))}
        {Array(SIZE).fill().map((_,y)=>Array(SIZE).fill().map((_,x)=>(
          <div key={`c${x},${y}`} onClick={()=>play(x,y)} style={{position:'absolute',left:OFFSET+x*CELL-CELL/2,top:OFFSET+y*CELL-CELL/2,width:CELL,height:CELL,cursor:'pointer'}}/>
        )))}
      </div>
      <div style={{marginTop:12}}><button onClick={pass}>PASS</button><button onClick={reset} style={{marginLeft:8}}>重置</button></div>
    </div>
  );
}
