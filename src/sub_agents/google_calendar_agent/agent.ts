import { calendar_v3, google } from "googleapis";
import { LlamaService } from "../../services/llama.js";
import { supabase } from "../../supabase.js"; // ✅ Use your Supabase client

export class GoogleCalendarAgent {
  private llama: LlamaService;

  constructor(llama: LlamaService) {
    this.llama = llama;
  }

  async processRequest(userId: number, request: string, context: any = {}) {
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("id", userId)
      .single();

    if (userError || !user || !user.google_token) {
      throw new Error("User not authenticated with Google");
    }

    const auth = this.createAuthClient(user.google_token);
    const calendar = google.calendar({ version: "v3", auth });

    if (request.includes("create") || context.action === "create") {
      return await this.createEvent(userId, calendar, context);
    } else if (request.includes("delete") || context.action === "delete") {
      return await this.deleteEvent(userId, calendar, context);
    } else if (request.includes("update") || context.action === "update") {
      return await this.updateEvent(userId, calendar, context);
    } else if (request.includes("slots") || context.action === "find_slots") {
      return await this.findAvailableSlots(userId, calendar, context);
    }

    // Default: list events
    return await this.listEvents(userId, calendar);
  }

  async createEvent(userId: number, calendar: calendar_v3.Calendar, context: any) {
    try {
      const event = {
        summary: context.title || "New Event",
        description: context.description || "",
        start: {
          dateTime: context.startTime,
          timeZone: "Europe/Paris",
        },
        end: {
          dateTime: context.endTime,
          timeZone: "Europe/Paris",
        },
        attendees: context.attendees || [],
      };

      const response = await calendar.events.insert({
        calendarId: "primary",
        requestBody: event,
      });

      // ✅ Store in Supabase
      const { error } = await supabase.from("events").insert([
        {
          user_id: userId,
          google_event_id: response.data.id, // 👈 updated column
          title: event.summary,
          start_time: event.start.dateTime,
          end_time: event.end.dateTime,
          status: "active",
        },
      ]);

      if (error) throw error;

      return { created: true, event: response.data };
    } catch (error) {
      console.error("Create event error:", error);
      throw error;
    }
  }

  async deleteEvent(userId: number, calendar: calendar_v3.Calendar, context: any) {
    try {
      await calendar.events.delete({
        calendarId: "primary",
        eventId: context.eventId,
      });

      // ✅ Update in Supabase
      const { error } = await supabase
        .from("events")
        .update({ status: "deleted" })
        .eq("google_event_id", context.eventId) // 👈 updated column
        .eq("user_id", userId);

      if (error) throw error;

      return { deleted: true, eventId: context.eventId };
    } catch (error) {
      console.error("Delete event error:", error);
      throw error;
    }
  }

  async updateEvent(userId: number, calendar: calendar_v3.Calendar, context: any) {
    try {
      const event = await calendar.events.get({
        calendarId: "primary",
        eventId: context.eventId,
      });

      const updatedEvent = {
        ...event.data,
        summary: context.title || event.data.summary,
        start: context.startTime
          ? { dateTime: context.startTime, timeZone: "Europe/Paris" }
          : event.data.start,
        end: context.endTime
          ? { dateTime: context.endTime, timeZone: "Europe/Paris" }
          : event.data.end,
      };

      const response = await calendar.events.update({
        calendarId: "primary",
        eventId: context.eventId,
        requestBody: updatedEvent,
      });

      // ✅ Update Supabase
      const { error } = await supabase
        .from("events")
        .update({
          title: updatedEvent.summary,
          start_time: updatedEvent.start?.dateTime,
          end_time: updatedEvent.end?.dateTime,
        })
        .eq("google_event_id", context.eventId) // 👈 updated column
        .eq("user_id", userId);

      if (error) throw error;

      return { updated: true, event: response.data };
    } catch (error) {
      console.error("Update event error:", error);
      throw error;
    }
  }

  async findAvailableSlots(userId: number, calendar: calendar_v3.Calendar, context: any) {
    try {
      const timeMin = context.startDate || new Date().toISOString();
      const timeMax =
        context.endDate ||
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const response = await calendar.freebusy.query({
        requestBody: {
          timeMin,
          timeMax,
          items: [{ id: "primary" }],
        },
      });

      const busyTimes = response.data.calendars?.primary?.busy || [];
      const slots = this.generateAvailableSlots(busyTimes, timeMin, timeMax);

      return { slots, busyTimes };
    } catch (error) {
      console.error("Find slots error:", error);
      throw error;
    }
  }

  async listEvents(userId: number, calendar: calendar_v3.Calendar) {
    try {
      const response = await calendar.events.list({
        calendarId: "primary",
        timeMin: new Date().toISOString(),
        maxResults: 50,
        singleEvents: true,
        orderBy: "startTime",
      });

      const googleEvents = response.data.items || [];

      // ✅ Sync into Supabase (upsert avoids duplicates)
      const mappedEvents = googleEvents.map((e) => ({
        user_id: userId,
        google_event_id: e.id, // 👈 updated column
        title: e.summary,
        start_time: e.start?.dateTime || e.start?.date,
        end_time: e.end?.dateTime || e.end?.date,
        status: "active",
      }));

      const { error } = await supabase.from("events").upsert(mappedEvents, {
        onConflict: "google_event_id,user_id", // 👈 updated
      });

      if (error) console.error("Supabase sync error:", error);

      return { events: googleEvents };
    } catch (error) {
      console.error("List events error:", error);
      throw error;
    }
  }

  private generateAvailableSlots(busyTimes: any[], timeMin: string, timeMax: string) {
    const slots = [];
    const workingHours = { start: 9, end: 17 }; // 9 AM to 5 PM
    const startDate = new Date(timeMin);
    const endDate = new Date(timeMax);

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      if (d.getDay() >= 1 && d.getDay() <= 5) {
        for (let hour = workingHours.start; hour < workingHours.end; hour++) {
          const slotStart = new Date(d);
          slotStart.setHours(hour, 0, 0, 0);
          const slotEnd = new Date(slotStart);
          slotEnd.setHours(hour + 1);

          const isConflict = busyTimes.some((busy) => {
            const busyStart = new Date(busy.start);
            const busyEnd = new Date(busy.end);
            return slotStart < busyEnd && slotEnd > busyStart;
          });

          if (!isConflict) {
            slots.push({
              start: slotStart.toISOString(),
              end: slotEnd.toISOString(),
            });
          }
        }
      }
    }

    return slots.slice(0, 10);
  }

  private createAuthClient(token: string) {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    auth.setCredentials(JSON.parse(token));
    return auth;
  }

  getStatus() {
    return "active";
  }
}
