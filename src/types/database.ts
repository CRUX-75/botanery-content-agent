export type JobType = 'CREATE_POST' | 'PUBLISH_POST' | 'COLLECT_FEEDBACK';
export type JobStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
export type PostStatus = 'DRAFT' | 'PUBLISHED' | 'FAILED' | 'ARCHIVED';
export type PostFormat = 'IG_CAROUSEL' | 'IG_SINGLE' | 'FB_CAROUSEL' | 'FB_SINGLE' | 'IG_REEL';
export type StyleType = 'fun' | 'clean' | 'warm' | 'tech' | 'educational';
export type ChannelTarget = 'IG_FB' | 'IG_ONLY' | 'FB_ONLY';
export type Channel = 'IG' | 'FB' | 'BOTH';

export interface Product {
  id: string;
  product_name: string;
  verkaufspreis: number;
  stock: number;
  is_active: boolean;
  description?: string;
  image_url?: string;
  created_at: string;
  updated_at: string;
}

export interface GeneratedPost {
  id: string;
  product_id: string;
  format: PostFormat;
  style: StyleType;
  angle?: string;
  hook: string;
  body: string;
  cta: string;
  hashtag_block?: string;
  image_prompt?: string;
  status: PostStatus;
  channel_target: ChannelTarget;
  ig_media_id?: string;
  fb_post_id?: string;
  channel?: Channel;
  ab_test_group_id?: string;
  created_at: string;
  published_at?: string;
  updated_at: string;
}

export interface Job {
  id: string;
  job_type: JobType;
  status: JobStatus;
  payload: Record<string, any>;
  attempts: number;
  error_message?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  updated_at: string;
}

export interface PostFeedback {
  id: string;
  post_id: string;
  metrics: PostMetrics;
  perf_score: number;
  collected_at?: string;
  collection_count: number;
  created_at: string;
  updated_at: string;
}

export interface PostMetrics {
  likes?: number;
  comments?: number;
  saves?: number;
  shares?: number;
  reach?: number;
  impressions?: number;
  clicks?: number;
}

export interface ProductPerformance {
  product_id: string;
  total_posts: number;
  total_impressions: number;
  total_engagement: number;
  avg_perf_score: number;
  perf_score: number;
  last_used_at?: string;
  last_updated: string;
}

export interface StylePerformance {
  style: StyleType;
  channel: 'IG' | 'FB';
  format: 'CAROUSEL' | 'SINGLE' | 'REEL';
  total_posts: number;
  total_impressions: number;
  total_engagement: number;
  avg_perf_score: number;
  perf_score: number;
  last_updated: string;
}