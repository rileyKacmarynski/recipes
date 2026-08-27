resource "cloudflare_record" "acm_caa_issue" {
  zone_id = var.cloudflare_zone_id
  name    = "rkac.dev"
  type    = "CAA"
  ttl     = 3600

  data {
    flags = 0
    tag   = "issue"
    value = "amazon.com"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_record" "acm_caa_issuewild" {
  zone_id = var.cloudflare_zone_id
  name    = "rkac.dev"
  type    = "CAA"
  ttl     = 3600

  data {
    flags = 0
    tag   = "issuewild"
    value = "amazon.com"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_record" "certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.app.domain_validation_options : option.domain_name => {
      name    = option.resource_record_name
      content = option.resource_record_value
      type    = option.resource_record_type
    }
  }

  zone_id = var.cloudflare_zone_id
  name    = each.value.name
  content = each.value.content
  type    = each.value.type
  ttl     = 60
  proxied = false

  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_record" "web" {
  zone_id = var.cloudflare_zone_id
  name    = var.web_hostname
  content = aws_cloudfront_distribution.web.domain_name
  type    = "CNAME"
  ttl     = 1
  proxied = true

  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_record" "api" {
  zone_id = var.cloudflare_zone_id
  name    = var.api_hostname
  content = aws_apigatewayv2_domain_name.api.domain_name_configuration[0].target_domain_name
  type    = "CNAME"
  ttl     = 1
  proxied = true

  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_zero_trust_access_policy" "web_owner" {
  account_id = var.cloudflare_account_id
  name       = "${var.name_prefix}-web-owner"
  decision   = "allow"

  include {
    email = [var.access_allowed_email]
  }
}

resource "cloudflare_zero_trust_access_application" "web" {
  account_id                 = var.cloudflare_account_id
  name                       = "${var.name_prefix}-web"
  domain                     = var.web_hostname
  type                       = "self_hosted"
  session_duration           = "24h"
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "lax"
  policies                   = [cloudflare_zero_trust_access_policy.web_owner.id]
}

resource "cloudflare_zero_trust_access_policy" "api_owner" {
  account_id = var.cloudflare_account_id
  name       = "${var.name_prefix}-api-owner"
  decision   = "allow"

  include {
    email = [var.access_allowed_email]
  }
}

resource "cloudflare_zero_trust_access_application" "api" {
  account_id                 = var.cloudflare_account_id
  name                       = "${var.name_prefix}-api"
  domain                     = var.api_hostname
  type                       = "self_hosted"
  session_duration           = "24h"
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "none"
  options_preflight_bypass   = true
  policies                   = [cloudflare_zero_trust_access_policy.api_owner.id]

  cors_headers {
    allow_credentials = true
    allowed_headers = [
      "authorization",
      "cf-access-jwt-assertion",
      "content-type",
    ]
    allowed_methods = [
      "DELETE",
      "GET",
      "OPTIONS",
      "PATCH",
      "POST",
      "PUT",
    ]
    allowed_origins = ["https://${var.web_hostname}"]
    max_age         = 3600
  }
}
