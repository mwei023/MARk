import 'dotenv/config';
import { toolsRegistry } from './src/tools';
console.log("Available tools:", Object.keys(toolsRegistry));
