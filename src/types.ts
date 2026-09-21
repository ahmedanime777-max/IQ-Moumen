export type AttributionSource = 'source' | 'estimated' | 'llm' | 'none';

export interface QuestionRecord {
  id: string; // uuid (qdrant point id)
  type: 'question' | 'passage';
  source: string; // human-friendly document name (file base name)
  documentId: string; // stable id derived from file name
  page: number;
  section?: string;
  number?: string; // question number as printed, if any

  questionText: string;
  choices?: string[];
  correctAnswer?: string;
  answerSource: AttributionSource;
  explanation?: string;
  explanationSource: AttributionSource;

  category?: string;
  categorySource: AttributionSource;
  difficulty?: string;
  difficultyEstimated: boolean;

  hasImage: boolean;
  requiresImage: boolean;
  imageRefs: string[]; // relative image paths under DATA_DIR/images

  contentHash: string;
  createdAt: string;
}

export interface DocumentRecord {
  id: string; // stable id derived from filename
  name: string; // file base name (e.g. book1.pdf)
  fileHash: string;
  pages: number;
  status: 'indexing' | 'ready' | 'error' | 'pending';
  questionCount: number;
  passageCount: number;
  imagePages: number;
  categories: string[];
  sections: string[];
  error?: string;
  indexedAt?: string;
  updatedAt: string;
}

export interface QuizQuestion {
  id: string;
  source: string;
  page: number;
  category?: string;
  difficulty?: string;
  questionText: string;
  choices?: string[];
  hasImage: boolean;
  imageUrls: string[];
}

export interface QuizRecord {
  id: string;
  createdAt: string;
  questionIds: string[];
  filters: Record<string, unknown>;
}
