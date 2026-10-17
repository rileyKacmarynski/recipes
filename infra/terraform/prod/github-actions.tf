resource "aws_iam_openid_connect_provider" "github_actions" {
  url = "https://token.actions.githubusercontent.com"

  client_id_list = ["sts.amazonaws.com"]

  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
  ]

  tags = local.tags
}

data "aws_iam_policy_document" "github_actions_deploy_assume_role" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github_actions.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [var.github_oidc_subject]
    }
  }
}

resource "aws_iam_role" "github_actions_deploy" {
  name               = "${local.name_prefix}-github-actions-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_actions_deploy_assume_role.json

  tags = local.tags
}

data "aws_iam_policy_document" "github_actions_deploy" {
  statement {
    sid = "ListTerraformStateBucket"

    actions = [
      "s3:GetBucketLocation",
      "s3:ListBucket",
    ]

    resources = ["arn:aws:s3:::${var.terraform_state_bucket}"]
  }

  statement {
    sid = "ReadTerraformOutputs"

    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${var.terraform_state_bucket}/prod/terraform.tfstate"]
  }

  statement {
    sid = "DeployWebArtifacts"

    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:PutObject",
    ]

    resources = [
      module.app_environment.web_bucket_arn,
      "${module.app_environment.web_bucket_arn}/*",
    ]
  }

  statement {
    sid = "InvalidateWebDistribution"

    actions = [
      "cloudfront:CreateInvalidation",
      "cloudfront:GetInvalidation",
    ]
    resources = [module.app_environment.cloudfront_distribution_arn]
  }

  statement {
    sid = "DeployApiLambda"

    actions = [
      "lambda:GetFunctionConfiguration",
      "lambda:InvokeFunction",
      "lambda:UpdateFunctionCode",
    ]

    resources = [module.app_environment.api_lambda_function_arn]
  }

  statement {
    sid = "RunDatabaseMigrations"

    actions = [
      "rds-data:BatchExecuteStatement",
      "rds-data:BeginTransaction",
      "rds-data:CommitTransaction",
      "rds-data:ExecuteStatement",
      "rds-data:RollbackTransaction",
    ]

    resources = [module.app_environment.database_resource_arn]
  }

  statement {
    sid = "ReadDatabaseMigrationCredentials"

    actions   = ["secretsmanager:GetSecretValue"]
    resources = [module.app_environment.database_secret_arn]
  }
}

resource "aws_iam_role_policy" "github_actions_deploy" {
  name   = "app-artifact-deploy"
  role   = aws_iam_role.github_actions_deploy.id
  policy = data.aws_iam_policy_document.github_actions_deploy.json
}

resource "aws_iam_role_policy_attachment" "github_actions_deploy_power_user" {
  role       = aws_iam_role.github_actions_deploy.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

resource "aws_iam_role_policy_attachment" "github_actions_deploy_iam_full_access" {
  role       = aws_iam_role.github_actions_deploy.name
  policy_arn = "arn:aws:iam::aws:policy/IAMFullAccess"
}

# Separate read-only planning identity. State-lock writes are limited to the
# backend lock object, not production resources or the state itself.
data "aws_iam_policy_document" "github_actions_plan_assume_role" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github_actions.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [replace(var.github_oidc_subject, ":environment:production", ":environment:production-plan")]
    }
  }
}

resource "aws_iam_role" "github_actions_plan" {
  name               = "${local.name_prefix}-github-actions-plan"
  assume_role_policy = data.aws_iam_policy_document.github_actions_plan_assume_role.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "github_actions_plan_read_only" {
  role       = aws_iam_role.github_actions_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

data "aws_iam_policy_document" "github_actions_plan_backend" {
  statement {
    actions   = ["s3:GetBucketLocation", "s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.terraform_state_bucket}"]
  }
  statement {
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${var.terraform_state_bucket}/prod/terraform.tfstate"]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${var.terraform_state_bucket}/prod/terraform.tfstate.tflock"]
  }
  # Explicit denies also constrain the broad AWS-managed read policy.
  statement {
    effect    = "Deny"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${var.terraform_state_bucket}/prod/terraform.tfstate"]
  }
}

resource "aws_iam_role_policy" "github_actions_plan_backend" {
  name   = "terraform-plan-backend"
  role   = aws_iam_role.github_actions_plan.id
  policy = data.aws_iam_policy_document.github_actions_plan_backend.json
}
