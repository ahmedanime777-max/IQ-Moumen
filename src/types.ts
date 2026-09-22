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

  language: 'ar' | 'en' | 'other';
  variantGroup?: string; // groups Arabic/English versions of the same source
  testNumber?: string;
  arabicText?: string; // cached Arabic presentation (translation) of questionText
  arabicChoices?: string[]; // cached Arabic presentation of choices
  confidence: number; // 0..1 extraction/recovery confidence

  contentHash: string;
  createdAt: string;
}

export interface DocumentRecord {
  id: string; // stable id derived from filename
  name: string; // file base name (e.g. book1.pdf)
  fileHash: string;
  pages: number;
  status: 'indexing' | 'ready' | 'error' | 'pending' | 'queued';
  phase?: string; // human-readable current phase (Extracting text, Indexing, ...)
  progress?: number; // 0..100
  questionCount: number;
  passageCount: number;
  imagePages: number;
  tests: number;
  language: 'ar' | 'en' | 'other';
  variantGroup?: string;
  linkedVariants: string[]; // names of linked source variants
  extractionMethod?: string;
  categories: string[];
  sections: string[];
  error?: string;
  warning?: string;
  sizeBytes?: number;
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
