import { LMStudioClient } from '@lmstudio/sdk';

async function test() {
  try {
    const client = new LMStudioClient({ baseUrl: 'ws://127.0.0.1:1234' });
    
    // List loaded models
    console.log('Listing loaded models...');
    const loadedModels = await client.llm.listLoaded();
    console.log('Loaded models:', JSON.stringify(loadedModels, null, 2));
    
    // Try to get the model (this should load it if not loaded)
    console.log('\nTrying to get model qwen3.5-9b...');
    const model = await client.llm.model('qwen3.5-9b', {
      config: { contextLength: 90000 },
      verbose: true,
    });
    
    console.log('Model loaded:', model);
    
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
  }
}

test();
