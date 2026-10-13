-- 0010: let a theme label its own archive routes.
--
-- Without a title, the router had to synthesise a heading for a listing page
-- from the query's content `type`, which is an internal slug — so a route
-- declared as /writing rendered a page headed "post". A theme knows what it
-- calls its own archive, so give it somewhere to say so.
--
-- SQLite cannot add a column with a non-constant default, but a plain
-- nullable TEXT column is fine, so this is a simple ADD COLUMN.

ALTER TABLE theme_routes ADD COLUMN title TEXT;

-- Pre-existing rows keep NULL: the router falls back to the template name.
