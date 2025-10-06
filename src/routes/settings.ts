import express from 'express';
import { supabase } from '../supabase.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

/**
 * Default classifier prompt (with rules)
 */
const DEFAULT_PROMPT = `Classify this email into one of these categories: Prise de RDV, Annulation, Modification, Information, Other.

CLASSIFICATION RULES:
- If email contains "mise à jour", "update", "modification", "changement", "reschedule" → "Modification"
- If email contains "annulation", "cancel", "cancelled" → "Annulation"
- If email contains "prise de rdv", "rendez-vous", "appointment", "book", "schedule new" → "Prise de RDV"
- Otherwise, classify based on content

Respond with ONLY the category name.`;

/**
 * Get user's classification prompt
 */
router.get('/prompt', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.userId;

    let { data: settings, error } = await supabase
      .from('settings')
      .select('classifier_prompt')
      .eq('user_id', userId)
      .single();

    if (error && error.code === 'PGRST116') {
      // No settings found, create default with rules
      const { data: newSettings, error: insertError } = await supabase
        .from('settings')
        .insert({
          user_id: userId,
          classifier_prompt: DEFAULT_PROMPT
        })
        .select()
        .single();

      if (insertError) {
        console.error('Error creating default settings:', insertError);
        return res.status(500).json({ error: 'Failed to create settings' });
      }

      settings = newSettings;
    } else if (error) {
      console.error('Error fetching settings:', error);
      return res.status(500).json({ error: 'Failed to fetch settings' });
    }

    res.json({
      classifier_prompt: settings?.classifier_prompt || DEFAULT_PROMPT
    });
  } catch (error: any) {
    console.error('Get prompt error:', error);
    res.status(500).json({ error: 'Failed to get classification prompt' });
  }
});

/**
 * Update user's classification prompt
 */
router.put('/prompt', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.userId;
    const { classifier_prompt } = req.body;

    if (!classifier_prompt || typeof classifier_prompt !== 'string') {
      return res.status(400).json({ error: 'Valid classifier_prompt is required' });
    }

    // Try to update existing settings
    const { data: updatedSettings, error: updateError } = await supabase
      .from('settings')
      .update({ 
        classifier_prompt,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .select()
      .single();

    if (updateError && updateError.code === 'PGRST116') {
      // No existing settings, create new
      const { data: newSettings, error: insertError } = await supabase
        .from('settings')
        .insert({
          user_id: userId,
          classifier_prompt
        })
        .select()
        .single();

      if (insertError) {
        console.error('Error creating settings:', insertError);
        return res.status(500).json({ error: 'Failed to create settings' });
      }

      return res.json({
        success: true,
        classifier_prompt: newSettings.classifier_prompt
      });
    } else if (updateError) {
      console.error('Error updating settings:', updateError);
      return res.status(500).json({ error: 'Failed to update settings' });
    }

    res.json({
      success: true,
      classifier_prompt: updatedSettings?.classifier_prompt
    });
  } catch (error: any) {
    console.error('Update prompt error:', error);
    res.status(500).json({ error: 'Failed to update classification prompt' });
  }
});

export { router as settingsRouter };
