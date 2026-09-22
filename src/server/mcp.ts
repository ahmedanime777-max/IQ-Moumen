import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config, CATEGORIES, DIFFICULTIES } from '../config.js';
import { logger } from '../utils/logger.js';
import * as lib from '../services/library.js';

const catDesc = `Optional category filter. One of: ${CATEGORIES.join(', ')}`;
const diffDesc = `Optional difficulty filter. One of: ${DIFFICULTIES.join(', ')}`;

function imageFilePath(url: string): string | null {
  const idx = url.indexOf('/rest/images/');
  if (idx === -1) return null;
  const ref = url.slice(idx + '/rest/images/'.length);
  const file = path.join(config.imagesDir, ref);
  return fs.existsSync(file) ? file : null;
}

// Build MCP content array: a JSON text block + image blocks when a question
// depends on visual information (so ChatGPT never has to guess).
function toContent(result: unknown): any {
  const content: any[] = [{ type: 'text', text: JSON.stringify(result, null, 2) }];
  const r = result as any;
  const wantsImages = r && (r.requiresImage || r.hasImage) && Array.isArray(r.imageUrls);
  if (wantsImages) {
    for (const url of r.imageUrls.slice(0, 3)) {
      const file = imageFilePath(url);
      if (file) {
        try {
          const data = fs.readFileSync(file).toString('base64');
          content.push({ type: 'image', data, mimeType: 'image/png' });
        } catch {
          /* skip unreadable image */
        }
      }
    }
  }
  return { content };
}

function errContent(e: unknown): any {
  return { content: [{ type: 'text', text: `Error: ${String(e)}` }], isError: true };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'iq-aptitude-trainer', version: '1.0.0' },
    {
      instructions:
        'Interactive Arabic-first IQ/aptitude trainer over the user\'s own uploaded sources. ' +
        'ALWAYS present questions, choices and explanations to the user in ARABIC, but keep all ' +
        'numeric digits in Western form (0-9, never ٠-٩). The tools already return Arabic text with ' +
        'Western digits — present it as-is. When the user practices: pick a question with get_question ' +
        'or get_random_question, present it WITHOUT the answer, wait for their answer, then call ' +
        'check_answer and explain in Arabic using the source explanation when available. Never reveal ' +
        'answers before the user attempts them. If a question requiresImage, show the returned image and ' +
        'do not guess missing visual content. If a field "recovery.used" is true, the Arabic content was ' +
        'reconstructed from an English source variant. Always keep source/page attribution.',
    }
  );

  server.registerTool(
    'list_sources',
    { title: 'List sources', description: 'List all uploaded and indexed sources.', inputSchema: {} },
    async () => {
      try {
        return toContent({ sources: lib.listSources() });
      } catch (e) {
        return errContent(e);
      }
    }
  );

  server.registerTool(
    'search_sources',
    {
      title: 'Search sources',
      description:
        'Semantically search the uploaded knowledge base. Prioritizes meaning over exact keywords.',
      inputSchema: {
        query: z.string().describe('Natural-language search query'),
        source: z.string().optional().describe('Optional source/document name filter'),
        category: z.string().optional().describe(catDesc),
        difficulty: z.string().optional().describe(diffDesc),
        limit: z.number().int().min(1).max(25).optional().describe('Max results (default 5)'),
      },
    },
    async (args) => {
      try {
        return toContent({ results: await lib.searchSources(args as any) });
      } catch (e) {
        return errContent(e);
      }
    }
  );

  server.registerTool(
    'get_question',
    {
      title: 'Get a question',
      description:
        'Retrieve a suitable question from the sources. Returns the question WITHOUT the answer.',
      inputSchema: {
        source: z.string().optional(),
        category: z.string().optional().describe(catDesc),
        difficulty: z.string().optional().describe(diffDesc),
        random: z.boolean().optional().describe('Pick randomly (default true)'),
      },
    },
    async (args) => {
      try {
        const q = await lib.getQuestion(args as any);
        return toContent(q ?? { error: 'No matching question found.' });
      } catch (e) {
        return errContent(e);
      }
    }
  );

  server.registerTool(
    'get_random_question',
    {
      title: 'Get a random question',
      description: 'Return a random question from the indexed sources.',
      inputSchema: {
        source: z.string().optional(),
        category: z.string().optional().describe(catDesc),
        difficulty: z.string().optional().describe(diffDesc),
      },
    },
    async (args) => {
      try {
        const q = await lib.getRandomQuestion(args as any);
        return toContent(q ?? { error: 'No question available.' });
      } catch (e) {
        return errContent(e);
      }
    }
  );

  server.registerTool(
    'generate_quiz',
    {
      title: 'Generate a quiz',
      description:
        'Create a quiz from the sources. Returns structured questions WITHOUT answers so it can be administered blind.',
      inputSchema: {
        number_of_questions: z.number().int().min(1).max(50),
        source: z.string().optional(),
        category: z.string().optional().describe(catDesc),
        difficulty: z.string().optional().describe(diffDesc),
        randomize: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        return toContent(await lib.generateQuiz(args as any));
      } catch (e) {
        return errContent(e);
      }
    }
  );

  server.registerTool(
    'check_answer',
    {
      title: 'Check an answer',
      description:
        "Check a user's answer against the source material. Prefers the source's own answer key and explanation; only uses reasoning fallback when the source has none.",
      inputSchema: {
        user_answer: z.string().describe("The learner's answer"),
        questionId: z.string().optional().describe('Question id returned by other tools'),
        question: z.string().optional().describe('Question text (used if no id)'),
        correct_answer: z.string().optional().describe('Correct answer if known by the caller'),
        explanation: z.string().optional(),
        source: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return toContent(await lib.checkAnswer(args as any));
      } catch (e) {
        return errContent(e);
      }
    }
  );

  server.registerTool(
    'get_explanation',
    {
      title: 'Get explanation',
      description:
        'Retrieve the explanation/solution for a question from the uploaded material (source-first).',
      inputSchema: {
        questionId: z.string().optional(),
        question: z.string().optional(),
        source: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const r = await lib.getExplanation(args as any);
        return toContent(r ?? { error: 'Question not found.' });
      } catch (e) {
        return errContent(e);
      }
    }
  );

  server.registerTool(
    'get_similar_questions',
    {
      title: 'Get similar questions',
      description: 'Given a question (id or text), find similar questions from the sources.',
      inputSchema: {
        questionId: z.string().optional(),
        question: z.string().optional(),
        source: z.string().optional(),
        category: z.string().optional().describe(catDesc),
        difficulty: z.string().optional().describe(diffDesc),
        limit: z.number().int().min(1).max(25).optional(),
      },
    },
    async (args) => {
      try {
        return toContent({ results: await lib.getSimilarQuestions(args as any) });
      } catch (e) {
        return errContent(e);
      }
    }
  );

  server.registerTool(
    'get_source_info',
    {
      title: 'Get source info',
      description: 'Return metadata about a source, including detected sections/categories.',
      inputSchema: { source: z.string().describe('Source/document name or id') },
    },
    async (args) => {
      try {
        const info = lib.getSourceInfo((args as any).source);
        return toContent(info ?? { error: 'Source not found.' });
      } catch (e) {
        return errContent(e);
      }
    }
  );

  // ---- ChatGPT connector compatibility aliases ----
  server.registerTool(
    'search',
    {
      title: 'Search',
      description: 'ChatGPT-compatible semantic search. Returns id/title/url/text results.',
      inputSchema: { query: z.string() },
    },
    async (args) => {
      try {
        const results = await lib.searchSources({ query: (args as any).query, limit: 10 });
        return toContent({
          results: results.map((r: any) => ({
            id: r.id,
            title: `${r.source} p.${r.page}${r.category ? ' · ' + r.category : ''}`,
            text: r.questionText,
            url: (r.imageUrls && r.imageUrls[0]) || '',
          })),
        });
      } catch (e) {
        return errContent(e);
      }
    }
  );

  server.registerTool(
    'fetch',
    {
      title: 'Fetch',
      description: 'ChatGPT-compatible fetch of a single question/document by id.',
      inputSchema: { id: z.string() },
    },
    async (args) => {
      try {
        const r = await lib.getExplanation({ questionId: (args as any).id });
        return toContent(r ?? { error: 'Not found' });
      } catch (e) {
        return errContent(e);
      }
    }
  );

  logger.debug('MCP server built with tools registered');
  return server;
}
