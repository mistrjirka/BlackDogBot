import { LMStudioClient } from '@lmstudio/sdk';

async function test() {
  try {
    const client = new LMStudioClient({ baseUrl: 'ws://127.0.0.1:1234' });
    
    // Get the model
    console.log('Getting model qwen3.5-9b...');
    const model = await client.llm.model('qwen3.5-9b');
    
    // Try to generate with a simple prompt
    console.log('Trying to generate text...');
    const result = await model.generate('Hello, how are you?', {
      maxTokens: 100,
    });
    
    console.log('Result:', result);
    
  } catch (error) {
    console.error('Error:', error.message);
    if (error.responseBody) {
      console.error('Response body:', error.responseBody);
    }
    if (error.statusCode) {
      console.error('Status code:', error.statusCode);
    }
  }
}

test();
