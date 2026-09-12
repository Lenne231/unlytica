import { useEffect, useState } from "react";
import "./App.css";

const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});

worker.onerror = () => {
  console.error("Worker failed to respond");
};

/*
return () => {
      worker.terminate();
    };
*/

function App() {
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<string[]>([]);

  useEffect(() => {
    worker.onmessage = (event: MessageEvent<string>) => {
      setMessages((prev) => [...prev, event.data]);
    };
  }, []);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    worker.postMessage(text);
    setText("");
  }

  return (
    <main className="worker-demo">
      <h1>Web Worker Demo</h1>
      <form onSubmit={onSubmit}>
        <input
          type="text"
          name="message"
          placeholder="Type a message"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit">Send Message</button>
      </form>
      <ul>
        {messages.map((message, index) => (
          <li key={index}>{message}</li>
        ))}
      </ul>
    </main>
  );
}

export default App;
