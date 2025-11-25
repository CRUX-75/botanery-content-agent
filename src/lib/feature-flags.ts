// src/lib/feature-flags.ts

import { supabaseAdmin } from './supabase';

class FeatureFlagService {
  private cache = new Map<string, any>();
  private lastFetch = 0;
  private CACHE_TTL = 60000; // 1 minuto

  async isEnabled(key: string): Promise<boolean> {
    const config = await this.getConfig(key);
    return config?.enabled || false;
  }

  async getRolloutPercentage(key: string): Promise<number> {
    const config = await this.getConfig(key);
    return config?.value?.rollout_percentage || 0;
  }

  async shouldUseFeature(key: string, entityId: string): Promise<boolean> {
    // Si la feature no está habilitada → siempre false
    const enabled = await this.isEnabled(key);
    if (!enabled) return false;

    const rollout = await this.getRolloutPercentage(key);

    // 0% → nunca
    if (rollout === 0) return false;

    // 100% → siempre
    if (rollout === 100) return true;

    // Hash consistente para cada producto / entityId
    const hash = this.hashString(entityId);
    return (hash % 100) < rollout;
  }

  // Obtiene config con caching para no hacer 1000 queries
  private async getConfig(key: string) {
    const now = Date.now();

    if (this.cache.has(key) && (now - this.lastFetch) < this.CACHE_TTL) {
      return this.cache.get(key);
    }

    const { data, error } = await supabaseAdmin
      .from('visual_config')
      .select('*')
      .eq('key', key)
      .single();

    if (error) {
      console.error(`❌ Error leyendo feature flag ${key}:`, error);
      return null;
    }

    this.cache.set(key, data);
    this.lastFetch = now;

    return data;
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  async setRollout(key: string, percentage: number) {
    await supabaseAdmin
      .from('visual_config')
      .update({
        value: { rollout_percentage: percentage },
        enabled: percentage > 0,
        updated_at: new Date().toISOString()
      })
      .eq('key', key);

    this.cache.clear(); // limpiar caché
  }
}

export const featureFlags = new FeatureFlagService();
