import { LearningAgent } from './LearningAgent.mjs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const agent = new LearningAgent(join(__dirname, 'storage_test'));

async function mockLLM(prompt) {
  console.log('\n--- LLM LLAMADO PARA REFLEXIÓN ---');
  console.log(prompt.slice(0, 150) + '...\n');
  return 'Inicia el video con una pregunta desafiante para retener a la audiencia desde el primer segundo.';
}

function logMsg(msg) {
  console.log(msg);
}

async function runTest() {
  console.log('Generando Video A (Simulado)...');
  
  const recordA = {
    sessionId: 'test_A',
    topic: 'Filosofía estoica',
    scriptData: {
      title: 'El secreto de los estoicos',
      hashtags: ['#estoicismo', '#filosofia'],
      script: 'Soy una inteligencia artificial... ¿Sabías que Marco Aurelio controlaba su mente así? Déjame tu comentario.'
    },
    renderStatus: 'success',
    publishStatus: 'success',
    tiktokMetrics: { views: 5000, likes: 200 }
  };

  await agent.recordVideoData(recordA, mockLLM, logMsg);

  // Wait a bit for the async reflection to complete
  await new Promise(r => setTimeout(r, 1000));

  console.log('\nGenerando Video B (Simulado)...');
  const context = agent.getLearningContext();
  console.log('\n--- CONTEXTO INYECTADO AL PROMPT DEL VIDEO B ---');
  console.log(context);
}

runTest();
