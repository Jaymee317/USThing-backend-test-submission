import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";
import { ObjectId } from "mongodb";

/**
 * A protected route plugin.
 *
 * Wrap protected routes in `fastify.withAuth(async (scope) => { ... })`. The
 * scope authenticates every request (populating `request.user`), documents the
 * auth error responses (400/401) automatically, and translates auth failures
 * into the right status codes — no manual `preHandler` or response merging is
 * needed. After successful authentication the verified user is available on
 * `request.user`.
 */

function icsCalendar(dateString: string): string {
  return new Date(dateString)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

const eventsRoute: FastifyPluginAsync = async (
  fastify: FastifyTypebox,
): Promise<void> => {
  fastify.withAuth(async (fastify) => {    
    const dbcollection = fastify.mongo.db?.collection("events");
    if (!dbcollection) {
      throw new Error("MongoDB database is not connected.");
    }

    //create (POST)
    fastify.post(
      "/",
      {
        schema: {
          summary: "Create Events",
          tags: ["Create"],
          security: [{ Auth: [] }],
          body: Type.Object({
            title: Type.String(),
            startTime: Type.String({ format: "date-time" }),
            endTime: Type.String({ format: "date-time" }),
          }),
          response: {
            201: Type.String(),
            401: Type.String(),
          },
        }
      },
      async (request, reply) => {
        const { title, startTime, endTime } = request.body;
        const owner = request.user.username; 
        //authorization handler: verify with token instead of name, since names can be duplicated

        //check if startTime and endTime are valid
        if (startTime >= endTime) {
          return reply.code(401).send("endTime must be after startTime");
        }

        //insert a new event to mongodb
        const result = await dbcollection.insertOne({
          owner,
          title,
          startTime,
          endTime,
        });

        const newEvent = {
          id: result.insertedId.toString(),
          owner,
          title,
          startTime,
          endTime,
        };

        return reply.status(201).send(`"${newEvent.title}" created!`);
      }
    );
    //read (GET) | authorization handler
    fastify.get(
      "/",
      {
        schema: {
          summary: "Read Events",
          tags: ["Read"],
          security: [{ Auth: [] }],
          response: {
            200: Type.Array(
              // description: "The authenticated user's username.",
              Type.Object({
                id: Type.String(),
                owner: Type.String(),
                title: Type.String(),
                startTime: Type.String(),
                endTime: Type.String(),
              }),
            ),
          },
        },
      },
      async (request, reply) => {
        //mongodb query to filter events involving owner
        const dbEvents = await dbcollection.find({ owner: request.user.username }).toArray();

        //format MongoDB to typebox schema
        const responseEvents = dbEvents.map((event) => ({
          id: event._id.toString(),
          owner: event.owner,
          title: event.title,
          startTime: event.startTime,
          endTime: event.endTime,
        }));

        return reply.status(200).send(responseEvents);
      }
    );
    // update (PUT)
    fastify.put(
      "/",
      {
        schema: {
          summary: "Update Events",
          tags: ["Update"],
          security: [{ Auth: [] }],
          body: Type.Object({
            //user must enter (unique) id so that the event can be identified
            id: Type.String(),
            //allow users to change the start time or end time
            startTime: Type.Optional(Type.String({ format: "date-time" })),
            endTime: Type.Optional(Type.String({ format: "date-time" })),
          }),
          response: {
            200: Type.Object({
              success: Type.Boolean(),
              message: Type.String(),
            }),
            401: Type.Object({
              success: Type.Boolean(),
              message: Type.String(),
            }),
          },
        },
      },
      async (request, reply) => {
        const { id, startTime, endTime } = request.body;
       
        //check if startTime and endTime are valid
        if ((startTime !== undefined) >= (endTime !== undefined)) {
          return reply.code(401).send({
            success: false,
            message: "endTime must be after startTime",
          });
        }

        await dbcollection.updateOne(
          { _id: new ObjectId(id), owner: request.user.username },
          {
            $set: {
              //conditions to ensure that time cannot be undefined
              ...(startTime !== undefined && { startTime }),
              ...(endTime !== undefined && { endTime }),
            },
          },
        );
        
        //query to find the specific event based on (unique) id
        const event = await dbcollection.findOne({
          _id: new ObjectId(id),
          owner: request.user.username, //ensure that the owner gets to update their own event
        });

        const responseEvents = event ? [{
          id: event._id.toString(),
          owner: event.owner,
          title: event.title,
          startTime: event.startTime,
          endTime: event.endTime,
        }] : [];

        //if mongodb fails to retrieve the event -> error
        if (event === null) {
          return reply.status(401).send({ 
            success: false, 
            message: "Event not found or unauthorized to update." 
          });
        }   
      
        //otherwise return successful response + updated details
        return reply.status(200).send({
          success: true,
          message: `Event successfully deleted.\n
          Here are the details:\n
          ${responseEvents}`,
        });
      }
    );
    // //delete (DELETE)
    fastify.delete(
      "/",
      {
        schema: {
          summary: "Delete Events",
          tags: ["Delete"],
          security: [{ Auth: [] }],
          body: Type.Object({
            //user must enter (unique) id so that the event can be identified
            id: Type.String(),
          }),
          response: {
            //successful response format
            200: Type.Object({
              success: Type.Boolean(),
              message: Type.String(),
            }),
            //failed response format
            401: Type.Object({
              success: Type.Boolean(),
              message: Type.String(),
            }),
          },
        },
      },
      async (request, reply) => {
        const { id } = request.body;
        
        //delete the specific event
        const event = await dbcollection.deleteOne({
          _id: new ObjectId(id),
          owner: request.user.username, //ensure that the owner gets to delete their own event
        });
        
        //if no event is deleted -> return failed response
        if (event.deletedCount === 0) {
          return reply.status(401).send({ 
            success: false, 
            message: "Event not found or unauthorized to delete." 
          });
        }    
        
        //otherwise return successful response
        return reply.status(200).send({
          success: true,
          message: "Event successfully deleted.",
        });      
      }
    );

    //extra feature: export calendar to .ics file
    fastify.get(
      "/export",
      {
        schema: {
          summary: "Export Events",
          tags: ["Export"],
          security: [{ Auth: [] }],
          response: {
            //successful response format
            200: Type.String(),
            //failed response format
            401: Type.String(),
          },
        }
      }, 
      async (request, reply) => {
        const dbEvents = await dbcollection.find({ owner: request.user.username }).toArray();

        const now = icsCalendar(new Date().toISOString());

        const calendarLines = [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "PRODID:-//USThing//Events//EN",
          "CALSCALE:GREGORIAN",
          "METHOD:PUBLISH",
        ];

        for (const event of dbEvents) {
          calendarLines.push(
            "BEGIN:VEVENT",
            `UID:${event._id.toString()}@usthing`,
            `DTSTAMP:${now}`,
            `DTSTART:${icsCalendar(event.startTime)}`,
            `DTEND:${icsCalendar(event.endTime)}`,
            `SUMMARY:${escapeIcsText(event.title)}`,
            "END:VEVENT",
          );
        }

        calendarLines.push("END:VCALENDAR");

        const calendar = calendarLines.join("\r\n") + "\r\n";

        return reply.code(200)
          .header("Content-Type", "text/calendar; charset=utf-8")
          .header("Content-Disposition", 'attachment; filename="my-events.ics"',)
          .send(calendar);
      }
    );
  });
};

export default eventsRoute;
