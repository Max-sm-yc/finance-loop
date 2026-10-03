-- Release inventory tracking and product analytics for all current and future organizations.
-- Server-side environment flags remain an independent operational kill switch.
alter table public.organization_feature_flags
  alter column inventory_tracking set default true,
  alter column product_analytics set default true;

update public.organization_feature_flags
   set inventory_tracking=true,
       product_analytics=true,
       updated_at=now()
 where not inventory_tracking or not product_analytics;
