DROP INDEX "publication_match_team_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "publication_match_user_unique" ON "publications" USING btree ("match_id","published_by");--> statement-breakpoint
CREATE INDEX "publication_match_team_idx" ON "publications" USING btree ("match_id","team");