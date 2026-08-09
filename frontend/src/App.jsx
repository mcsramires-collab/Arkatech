import { useEffect, useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export default function App() {
  const [status, setStatus] = useState('verificando...');

  useEffect(() => {
    fetch(`${API_URL}/health`)
      .then((r) => r.json())
      .then((data) => setStatus(JSON.stringify(data)))
      .catch((err) => setStatus(`erro ao conectar na API: ${err.message}`));
  }, []);

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
      <h1>ARCKATECH — Portal de Gestão</h1>
      <p>Status da API ({API_URL}):</p>
      <pre>{status}</pre>
    </div>
  );
}
