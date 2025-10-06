import express, { Request, Response } from 'express';
import { supabase } from '../supabase.js';
import { authenticateToken } from './auth.js';

// Extend Request type to include `user`
interface AuthRequest extends Request {
  user?: { userId: string };
}

const router = express.Router();

/**
 * Utility: Ensure user exists in public.users
 */
async function ensureUserExists(userId: string) {
  const { data: existingUser, error: userError } = await supabase
    .from('users')
    .select('id')
    .eq('id', userId)
    .maybeSingle();

  if (userError) throw userError;

  if (!existingUser) {
    const { error: insertError } = await supabase
      .from('users')
      .insert({ id: userId });

    if (insertError) throw insertError;
    console.log(`✅ Created missing user record for ${userId}`);
  }
}

/**
 * GET /api/prompts - Fetch user's prompts
 */
router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    await ensureUserExists(userId);

    const { data: prompts, error } = await supabase
      .from('prompts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ prompts: prompts || [] });
  } catch (error) {
    console.error('❌ Error fetching prompts:', error);
    res.status(500).json({ error: 'Failed to fetch prompts' });
  }
});

/**
 * POST /api/prompts - Create new prompt
 */
router.post('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { name, content } = req.body;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!name?.trim() || !content?.trim()) {
      return res.status(400).json({ error: 'Name and content are required' });
    }

    await ensureUserExists(userId);

    // Enforce max 5 prompts per user
    const { count, error: countError } = await supabase
      .from('prompts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (countError) throw countError;
    if ((count ?? 0) >= 5) {
      return res.status(400).json({ error: 'Maximum of 5 prompts allowed' });
    }

    const { data: prompt, error } = await supabase
      .from('prompts')
      .insert({
        user_id: userId,
        name: name.trim(),
        content: content.trim(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .maybeSingle();

    if (error) throw error;

    res.json({ success: true, prompt });
  } catch (error) {
    console.error('❌ Error creating prompt:', error);
    res.status(500).json({ error: 'Failed to create prompt' });
  }
});

/**
 * PUT /api/prompts/:id - Update prompt
 */
router.put('/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { id } = req.params;
    const { name, content } = req.body;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!name?.trim() || !content?.trim()) {
      return res.status(400).json({ error: 'Name and content are required' });
    }

    await ensureUserExists(userId);

    const { data: prompt, error } = await supabase
      .from('prompts')
      .update({
        name: name.trim(),
        content: content.trim(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!prompt) return res.status(404).json({ error: 'Prompt not found' });

    res.json({ success: true, prompt });
  } catch (error) {
    console.error('❌ Error updating prompt:', error);
    res.status(500).json({ error: 'Failed to update prompt' });
  }
});

/**
 * DELETE /api/prompts/:id - Delete prompt
 */
router.delete('/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { id } = req.params;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    await ensureUserExists(userId);

    const { error } = await supabase
      .from('prompts')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error deleting prompt:', error);
    res.status(500).json({ error: 'Failed to delete prompt' });
  }
});

/**
 * POST /api/prompts/reset - Reset to default templates
 */
router.post('/reset', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    await ensureUserExists(userId);

    // Delete old prompts
    const { error: deleteError } = await supabase
      .from('prompts')
      .delete()
      .eq('user_id', userId);

    if (deleteError) throw deleteError;

    const defaultPrompts = [
      {
        name: 'Appointment Request',
        content: 'Identify emails requesting appointments or meetings and summarize the details.',
      },
      {
        name: 'Cancellation',
        content: 'Detect emails that cancel or postpone meetings and extract relevant details.',
      },
      {
        name: 'Modification Request',
        content: 'Identify emails that modify meeting details or propose new times.',
      },
      {
        name: 'Information Request',
        content: 'Classify emails asking for additional information or clarifications.',
      },
      {
        name: 'General Response',
        content: 'Generate a polite and professional response to general emails.',
      },
    ].map(p => ({
      ...p,
      user_id: userId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    const { data: prompts, error } = await supabase
      .from('prompts')
      .insert(defaultPrompts)
      .select();

    if (error) throw error;

    res.json({ success: true, prompts });
  } catch (error) {
    console.error('❌ Error resetting prompts:', error);
    res.status(500).json({ error: 'Failed to reset prompts' });
  }
});

export { router as promptsRouter };
