// The browser calls our own server. It never receives the provider API key.
(() => {
  const queue = [];
  const controllers = new Set();
  let active = 0;
  let generation = 0;
  const cancelled = () => Object.assign(new Error('Request stopped.'), { name: 'AbortError' });

  async function send(prompt, epoch) {
    if (epoch !== generation) throw cancelled();
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 65000);
    try {
      const response = await fetch('/api/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => null);
      if (epoch !== generation) throw cancelled();
      if (!response.ok) throw new Error(data?.error || 'The AI service is unavailable. Please try again.');
      if (typeof data?.text !== 'string') throw new Error('The AI service returned an invalid response.');
      return data.text;
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }

  function drain() {
    while (active < 2 && queue.length) {
      const item = queue.shift();
      active++;
      send(item.prompt, item.epoch).then(item.resolve, item.reject).finally(() => { active--; drain(); });
    }
  }

  window.adaptationAI = {
    complete(prompt) {
      return new Promise((resolve, reject) => { queue.push({ prompt, resolve, reject, epoch: generation }); drain(); });
    },
    cancel() {
      generation++;
      while (queue.length) queue.shift().reject(cancelled());
      for (const controller of controllers) controller.abort();
    }
  };
})();
