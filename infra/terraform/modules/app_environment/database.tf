data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  database_name = "recipes"
}

resource "aws_vpc" "database" {
  cidr_block           = "10.42.0.0/24"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(local.tags, {
    Name = "${var.name_prefix}-database"
  })
}

resource "aws_subnet" "database" {
  for_each = {
    a = {
      availability_zone = data.aws_availability_zones.available.names[0]
      cidr_block        = "10.42.0.0/26"
    }
    b = {
      availability_zone = data.aws_availability_zones.available.names[1]
      cidr_block        = "10.42.0.64/26"
    }
  }

  vpc_id            = aws_vpc.database.id
  availability_zone = each.value.availability_zone
  cidr_block        = each.value.cidr_block

  tags = merge(local.tags, {
    Name = "${var.name_prefix}-database-${each.key}"
  })
}

resource "aws_route_table" "database" {
  vpc_id = aws_vpc.database.id

  tags = merge(local.tags, {
    Name = "${var.name_prefix}-database"
  })
}

resource "aws_route_table_association" "database" {
  for_each = aws_subnet.database

  subnet_id      = each.value.id
  route_table_id = aws_route_table.database.id
}

resource "aws_security_group" "database" {
  name        = "${var.name_prefix}-database"
  description = "Private Aurora database security group. Data API access does not require inbound network access."
  vpc_id      = aws_vpc.database.id

  tags = merge(local.tags, {
    Name = "${var.name_prefix}-database"
  })
}

resource "aws_db_subnet_group" "database" {
  name       = "${var.name_prefix}-database"
  subnet_ids = [for subnet in aws_subnet.database : subnet.id]

  tags = merge(local.tags, {
    Name = "${var.name_prefix}-database"
  })
}

resource "aws_rds_cluster" "database" {
  cluster_identifier          = "${var.name_prefix}-database"
  database_name               = local.database_name
  db_subnet_group_name        = aws_db_subnet_group.database.name
  deletion_protection         = true
  enable_http_endpoint        = true
  engine                      = "aurora-postgresql"
  engine_mode                 = "provisioned"
  engine_version              = "18.4.1"
  manage_master_user_password = true
  master_username             = "recipes_admin"
  storage_encrypted           = true
  vpc_security_group_ids      = [aws_security_group.database.id]

  backup_retention_period = 7
  preferred_backup_window = "07:00-09:00"

  serverlessv2_scaling_configuration {
    max_capacity = 1
    min_capacity = 0
  }

  tags = merge(local.tags, {
    Name = "${var.name_prefix}-database"
  })
}

resource "aws_rds_cluster_instance" "database" {
  cluster_identifier  = aws_rds_cluster.database.id
  identifier          = "${var.name_prefix}-database-1"
  instance_class      = "db.serverless"
  engine              = aws_rds_cluster.database.engine
  engine_version      = aws_rds_cluster.database.engine_version
  publicly_accessible = false

  tags = merge(local.tags, {
    Name = "${var.name_prefix}-database-1"
  })
}
