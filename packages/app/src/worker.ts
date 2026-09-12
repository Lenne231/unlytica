self.onmessage = (event: MessageEvent<string>) => {
  self.postMessage(`hello: ${event.data}`);
};
