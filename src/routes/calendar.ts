import express from 'express';
import { google } from 'googleapis';
import { supabase } from '../supabase.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

// ----------------------
// Helper: Google client
// ----------------------
async function createAuthenticatedClient(userId: string) {
  const { data: user, error } = await supabase
    .from('users')
    .select('google_token')
    .eq('id', userId)
    .single();

  if (error || !user?.google_token) {
    throw new Error('User not authenticated with Google');
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  const tokens = JSON.parse(user.google_token);
  oauth2Client.setCredentials(tokens);

  // Refresh handler
  oauth2Client.on('tokens', async (newTokens) => {
    const updatedTokens = { ...tokens, ...newTokens };
    await supabase
      .from('users')
      .update({ google_token: JSON.stringify(updatedTokens) })
      .eq('id', userId);
  });

  return oauth2Client;
}

// ----------------------
// List events (past + future)
// ----------------------
router.get('/events', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.userId;

    // 1. Get local Supabase events
    const { data: localEvents, error: localError } = await supabase
      .from('events')
      .select('*')
      .eq('user_id', userId)
      .order('start_time', { ascending: true });

    if (localError) {
      console.error('Error fetching local events:', localError);
    }

    // 2. Get Google Calendar events
    const auth = await createAuthenticatedClient(userId);
    const calendar = google.calendar({ version: 'v3', auth });

    const timeMin = new Date();
    timeMin.setDate(timeMin.getDate() - 30);
    const timeMax = new Date();
    timeMax.setDate(timeMax.getDate() + 60);

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults: 250,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const googleEvents = (response.data.items || []).map((event) => ({
      id: event.id,
      title: event.summary || 'No title',
      description: event.description || '',
      start_time: event.start?.dateTime || event.start?.date,
      end_time: event.end?.dateTime || event.end?.date,
      attendees: event.attendees || [],
      location: event.location || '',
      status: event.status || 'confirmed',
      source: 'google',
    }));

    // 3. Map Supabase events into same shape
    const formattedLocalEvents = (localEvents || []).map((event) => ({
      id: event.id,
      title: event.title,
      description: event.description,
      start_time: event.start_time,
      end_time: event.end_time,
      attendees: event.attendees,
      location: event.location,
      status: 'confirmed',
      google_event_id: event.google_event_id,
      source: event.google_event_id ? 'synced' : 'local',
    }));

    // 4. Merge: keep Google + local-only events
    //    If Supabase event has google_event_id, don't duplicate it
    const googleIds = new Set(googleEvents.map((e) => e.id));
    const localOnlyEvents = formattedLocalEvents.filter(
      (ev) => !ev.google_event_id || !googleIds.has(ev.google_event_id)
    );

    const mergedEvents = [...googleEvents, ...localOnlyEvents];

    res.json({
      success: true,
      events: mergedEvents,
      stats: {
        google: googleEvents.length,
        local: localOnlyEvents.length,
        merged: mergedEvents.length,
      },
    });
  } catch (error: any) {
    console.error('List events error:', error);
    if (
      error.message.includes('invalid_grant') ||
      error.message.includes('unauthorized')
    ) {
      res
        .status(401)
        .json({ error: 'Authentication expired. Please login again.' });
    } else {
      res.status(500).json({ error: 'Failed to list events' });
    }
  }
});


// ----------------------
// Sync event from Email
// ----------------------
router.post('/events/sync-from-email/:emailId', authenticateToken, async (req: any, res) => {
  try {
    const { emailId } = req.params;
    const userId = req.user.userId;

    // 1. Fetch email
    const { data: email, error: emailError } = await supabase
      .from('emails')
      .select('*')
      .eq('id', emailId)
      .eq('user_id', userId)
      .single();

    if (emailError || !email) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const category = email.category;
    const eligible = ['Prise de RDV', 'Modification', 'Annulation'];
    if (!eligible.includes(category)) {
      return res.status(400).json({ error: 'Email not eligible for calendar sync' });
    }

    // 2. Extract event data (simplified — you may already use Llama parsing)
    const eventData = {
      title: email.subject,
      description: email.body?.substring(0, 500) || '',
      startTime: req.body.startTime || new Date().toISOString(),
      endTime: req.body.endTime || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      attendees: req.body.attendees || [email.sender],
      location: req.body.location || '',
    };

    // 3. Find existing event (by email_id)
    const { data: existingEvent } = await supabase
      .from('events')
      .select('*')
      .eq('email_id', email.id)
      .eq('user_id', userId)
      .maybeSingle();

    const auth = await createAuthenticatedClient(userId);
    const calendar = google.calendar({ version: 'v3', auth });

    // 4. Handle by category
    if (category === 'Annulation' && existingEvent) {
      if (existingEvent.google_event_id) {
        try {
          await calendar.events.delete({
            calendarId: 'primary',
            eventId: existingEvent.google_event_id,
          });
        } catch (err: any) {
          console.warn('Google delete failed:', err.message);
        }
      }
      await supabase.from('events').delete().eq('id', existingEvent.id);
      return res.json({ success: true, action: 'deleted' });
    }

    if (category === 'Modification' && existingEvent) {
      // Update Google
      if (existingEvent.google_event_id) {
        await calendar.events.update({
          calendarId: 'primary',
          eventId: existingEvent.google_event_id,
          requestBody: {
            summary: eventData.title,
            description: eventData.description,
            start: { dateTime: eventData.startTime, timeZone: 'UTC' },
            end: { dateTime: eventData.endTime, timeZone: 'UTC' },
            attendees: eventData.attendees.map((email: string) => ({ email })),
            location: eventData.location,
          },
        });
      }
      // Update Supabase
      await supabase.from('events').update({
        title: eventData.title,
        description: eventData.description,
        start_time: eventData.startTime,
        end_time: eventData.endTime,
        attendees: eventData.attendees,
        location: eventData.location,
      }).eq('id', existingEvent.id);
      return res.json({ success: true, action: 'updated' });
    }

    // Otherwise: create (Prise de RDV or Modification without existing event)
    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: eventData.title,
        description: eventData.description,
        start: { dateTime: eventData.startTime, timeZone: 'UTC' },
        end: { dateTime: eventData.endTime, timeZone: 'UTC' },
        attendees: eventData.attendees.map((email: string) => ({ email })),
        location: eventData.location,
      },
    });

    const { data: newEvent } = await supabase.from('events').upsert({
      user_id: userId,
      email_id: email.id,
      google_event_id: response.data.id,
      title: eventData.title,
      description: eventData.description,
      start_time: eventData.startTime,
      end_time: eventData.endTime,
      attendees: eventData.attendees,
      location: eventData.location,
    }, { onConflict: 'google_event_id' }).select().single();

    res.json({ success: true, action: 'created', event: newEvent });
  } catch (err: any) {
    console.error('Sync from email error:', err.message);
    res.status(500).json({ error: 'Failed to sync event from email' });
  }
});


// ----------------------
// Create event
// ----------------------
router.post('/events/create', authenticateToken, async (req: any, res) => {
  try {
    const auth = await createAuthenticatedClient(req.user.userId);
    const calendar = google.calendar({ version: 'v3', auth });

    const { title, startTime, endTime, description, attendees, location } =
      req.body;

    const event = {
      summary: title,
      description: description || '',
      start: { dateTime: startTime, timeZone: 'UTC' },
      end: { dateTime: endTime, timeZone: 'UTC' },
      attendees: attendees || [],
      location: location || '',
    };

    // First check if event with same title + time exists in Supabase
    const { data: existing, error: checkError } = await supabase
      .from('events')
      .select('*')
      .eq('user_id', req.user.userId)
      .eq('title', title)
      .eq('start_time', startTime)
      .eq('end_time', endTime)
      .maybeSingle();

    if (checkError) {
      console.error('Error checking duplicates:', checkError);
    }

    if (existing) {
      return res.json({ success: false, message: 'Event already exists', existing });
    }

    // Insert into Google Calendar
    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
    });

    // Save (upsert instead of insert to avoid duplicates if Google ID already exists)
    const { data: localEvent, error } = await supabase
      .from('events')
      .upsert({
        user_id: req.user.userId,
        google_event_id: response.data.id,
        title,
        description: description || '',
        start_time: startTime,
        end_time: endTime,
        attendees: attendees || [],
        location: location || '',
      }, { onConflict: 'google_event_id' })
      .select()
      .single();

    if (error) {
      console.error('Error storing local event:', error);
    }

    res.json({ success: true, event: response.data, localEvent });
  } catch (error: any) {
    console.error('Create event error:', error);
    if (
      error.message.includes('invalid_grant') ||
      error.message.includes('unauthorized')
    ) {
      res
        .status(401)
        .json({ error: 'Authentication expired. Please login again.' });
    } else {
      res.status(500).json({ error: 'Failed to create event' });
    }
  }
});

// ----------------------
// Delete event
// ----------------------
router.delete('/events/:eventId', authenticateToken, async (req: any, res) => {
  try {
    const auth = await createAuthenticatedClient(req.user.userId);
    const calendar = google.calendar({ version: 'v3', auth });

    const { eventId } = req.params;

    await calendar.events.delete({
      calendarId: 'primary',
      eventId: eventId,
    });

    await supabase
      .from('events')
      .delete()
      .eq('google_event_id', eventId)
      .eq('user_id', req.user.userId);

    res.json({ success: true, message: 'Event deleted successfully' });
  } catch (error: any) {
    console.error('Delete event error:', error);
    if (
      error.message.includes('invalid_grant') ||
      error.message.includes('unauthorized')
    ) {
      res
        .status(401)
        .json({ error: 'Authentication expired. Please login again.' });
    } else {
      res.status(500).json({ error: 'Failed to delete event' });
    }
  }
});

export { router as calendarRouter };
