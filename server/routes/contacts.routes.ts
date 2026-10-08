import { Router } from "express";
import multer from "multer";
import * as c from "../controllers/contacts.controller";
import { requirePermission } from "../middlewares/auth";
import { requireChannelAccess } from "../middlewares/tenant";
import { asyncHandler as h } from "../lib/http";

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

export const contactRoutes = Router();
const channel = requireChannelAccess();
contactRoutes.get("/contacts", requirePermission("contacts:view"), channel, h(c.listContacts));
contactRoutes.get("/contacts/export", requirePermission("contacts:export"), channel, h(c.exportContacts));
contactRoutes.post("/contacts/import", requirePermission("contacts:create"), csvUpload.single("file"), channel, h(c.importContacts));
contactRoutes.get("/contacts/fields", requirePermission("contacts:view"), h(c.listFields));
contactRoutes.get("/contacts/:id", requirePermission("contacts:view"), h(c.getContact));
contactRoutes.get("/contacts/:id/timeline", requirePermission("contacts:view"), h(c.timeline));
contactRoutes.get("/contacts/:id/summary", requirePermission("contacts:view"), h(c.summary));
// Inbox agents keep notes on the people they chat with, so either permission is enough.
contactRoutes.post("/contacts/:id/notes", requirePermission("contacts:edit", "inbox:send"), h(c.addNote));
contactRoutes.delete("/contacts/:id/notes/:noteId", requirePermission("contacts:edit", "inbox:send"), h(c.deleteNote));
contactRoutes.post("/contacts", requirePermission("contacts:create"), channel, h(c.createContact));
contactRoutes.put("/contacts/:id", requirePermission("contacts:edit"), h(c.updateContact));
contactRoutes.delete("/contacts/:id", requirePermission("contacts:delete"), h(c.deleteContact));
contactRoutes.delete("/contacts-bulk", requirePermission("contacts:delete"), channel, h(c.bulkDeleteContacts));
