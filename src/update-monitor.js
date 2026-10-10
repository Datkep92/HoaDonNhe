'use strict';
// Runs in the server, independently of any browser window.
function createUpdateMonitor({check, publish, now=Date.now, interval=15*60*1000, retry=5*60*1000}) {
  let nextAt=0, running=false, announced='';
  return async function tick() {
    if(running || now()<nextAt)return;
    running=true;
    try {
      const state=await check();
      nextAt=now()+((state.checkFailed || state.error) ? retry : interval);
      if(state.updateAvailable && state.latest && announced!==state.latest) {
        await publish(state);
        announced=state.latest;
      }
      return state;
    } catch(error) {nextAt=now()+retry;throw error;}
    finally {running=false;}
  };
}
module.exports={createUpdateMonitor};
