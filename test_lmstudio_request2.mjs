import { LMStudioClient } from '@lmstudio/sdk';

async function test() {
  try {
    const client = new LMStudioClient({ baseUrl: 'ws://127.0.0.1:1234' });
    
    // Get the model
    console.log('Getting model qwen3.5-9b...');
    const model = await client.llm.model('qwen3.5-9b');
    
    // Check what methods are available
    console.log('Model methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(model)));
    
    // Try to use the model for completion
    console.log('\nTrying to generate text...');
    
    // Check if there's a completions or chat method
    if (model.completions) {
      console.log('Using completions...');
      const result = await model.completions.create({
        prompt: 'Hello, how are you?',
        max_tokens: 100,
      });
      console.log('Result:', result);
    } else if (model.chat) {
      console.log('Using chat...');
      const result = await model.chat({
        messages: [{ role: 'user', content: 'Hello, how are you?' }],
        max_tokens: 100,
      });
      console.log('Result:', result);
    } else {
      console.log('No completions or chat method found');
      console.log('Model keys:', Object.keys(model));
    }
    
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
