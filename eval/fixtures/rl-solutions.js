// Grader QA fixtures, never placed in provider prompts. Implementations use
// different computational forms from the private mathematical oracles.
export const rlSolutions = {
  'rl-gae-boundaries': `function solve(d) {
    const advantages = Array(d.rewards.length), returns = Array(d.rewards.length); let carry = 0;
    for(let t=d.rewards.length-1;t>=0;t--) {
      const delta=d.rewards[t]+(d.terminated[t]?0:d.gamma*d.nextValues[t])-d.values[t];
      carry=delta+((d.terminated[t]||d.truncated[t])?0:d.gamma*d.lambda*carry);
      advantages[t]=carry; returns[t]=carry+d.values[t];
    }
    return {advantages,returns};
  }`,
  'rl-nstep-targets': `function solve(d) {
    return d.rewards.map((_,t)=>{
      let answer=0,weight=1,end=t;
      for(let k=0;k<d.n&&t+k<d.rewards.length;k++) {
        end=t+k; answer+=weight*d.rewards[end]; weight*=d.gamma;
        if(d.terminated[end]||d.truncated[end]) break;
      }
      if(!d.terminated[end]) answer+=weight*d.nextValues[end];
      return answer;
    });
  }`,
  'rl-ppo-clipped': `function solve(d) {
    const ids=d.mask.map((v,i)=>v===true?i:-1).filter(i=>i>=0),n=ids.length;
    if(!n) return {policyLoss:0,valueLoss:0,clipFraction:0,approxKL:0};
    const avg=ids.reduce((x,i)=>x+d.advantages[i],0)/n;
    const variance=ids.reduce((x,i)=>x+(d.advantages[i]-avg)**2,0)/n;
    const clip=(x,l,h)=>Math.max(l,Math.min(h,x));
    let policyLoss=0,valueLoss=0,clipFraction=0,approxKL=0;
    for(const i of ids) {
      const a=d.normalizeAdvantages?(d.advantages[i]-avg)/Math.sqrt(variance+1e-8):d.advantages[i];
      const log=d.newLogProbs[i]-d.oldLogProbs[i],r=Math.exp(log);
      policyLoss-=Math.min(r*a,clip(r,1-d.epsilon,1+d.epsilon)*a)/n;
      const v=d.oldValues[i]+clip(d.newValues[i]-d.oldValues[i],-d.valueClip,d.valueClip);
      valueLoss+=Math.max((d.newValues[i]-d.returns[i])**2,(v-d.returns[i])**2)/(2*n);
      clipFraction+=(Math.abs(r-1)>d.epsilon?1:0)/n; approxKL+=(r-1-log)/n;
    }
    return {policyLoss,valueLoss,clipFraction,approxKL};
  }`,
  'rl-tabular-bellman': `function solve(d) {
    let values=d.initialValues.slice();
    const qs=v=>d.transitions.map(actions=>actions.map(outcomes=>outcomes.reduce((sum,o)=>sum+o.p*(o.reward+(o.terminated?0:d.gamma*v[o.next])),0)));
    for(let h=0;h<d.horizon;h++) {
      const q=qs(values); values=q.map((row,s)=>row.reduce((sum,value,a)=>sum+d.policy[s][a]*value,0));
    }
    const qValues=qs(values),greedyActions=qValues.map(row=>row.indexOf(Math.max(...row)));
    return {values,qValues,greedyActions};
  }`,
  'rl-vtrace': `function solve(d) {
    const n=d.rewards.length,vs=Array(n),pgAdvantages=Array(n);let correction=0;
    for(let t=n-1;t>=0;t--) {
      const ratio=Math.exp(d.logRhos[t]);
      const delta=Math.min(d.rhoClip,ratio)*(d.rewards[t]+(d.terminated[t]?0:d.gamma*d.nextValues[t])-d.values[t]);
      correction=delta+((d.terminated[t]||d.truncated[t])?0:d.gamma*d.lambda*Math.min(d.cClip,ratio)*correction);
      vs[t]=d.values[t]+correction;
    }
    for(let t=0;t<n;t++) {
      const bootstrap=t+1<n&&!d.terminated[t]&&!d.truncated[t]?vs[t+1]:d.nextValues[t];
      pgAdvantages[t]=Math.min(d.pgRhoClip,Math.exp(d.logRhos[t]))*(d.rewards[t]+(d.terminated[t]?0:d.gamma*bootstrap)-d.values[t]);
    }
    return {vs,pgAdvantages};
  }`,
  'rl-experiment-aggregate': `function solve(d) {
    const tasks=d.tasks.map(task=>{
      let n=0,mean=0,m2=0;const seeds=[];
      for(const run of task.runs) {
        let best=null;
        for(const point of run.checkpoints) if(point.step<=d.step&&(!best||point.step>=best.step)) best=point;
        if(!best) continue;
        const x=(best.score-task.baseline)/(task.reference-task.baseline);
        n++;const delta=x-mean;mean+=delta/n;m2+=delta*(x-mean);seeds.push(run.seed);
      }
      seeds.sort((a,b)=>a-b);
      return {id:task.id,n,seeds,mean:n?mean:null,standardError:n>1?Math.sqrt(m2/(n-1)/n):null};
    }).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    const means=tasks.filter(t=>t.n>0).map(t=>t.mean).sort((a,b)=>a-b),n=means.length;
    if(!n) return {tasks,macroMean:null,iqm:null};
    let trimmed=0;
    for(let i=0;i<n;i++) {
      const left=Math.max(i,n/4),right=Math.min(i+1,3*n/4);
      if(right>left) trimmed+=(right-left)*means[i];
    }
    return {tasks,macroMean:means.reduce((a,b)=>a+b,0)/n,iqm:trimmed/(n/2)};
  }`,
};
